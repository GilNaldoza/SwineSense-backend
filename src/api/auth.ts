import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../db';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { logAudit } from '../utils/audit';

const router = Router();

// Simple in-memory rate limiter for login
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Cleanup stale entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of loginAttempts.entries()) {
        if (now > val.resetAt) loginAttempts.delete(key);
    }
}, 5 * 60 * 1000);

router.post('/login', async (req: Request, res: Response) => {
    // Rate limiting check
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempt = loginAttempts.get(clientIp);
    if (attempt) {
        if (now > attempt.resetAt) {
            loginAttempts.delete(clientIp);
        } else if (attempt.count >= RATE_LIMIT_MAX) {
            const retryAfterSec = Math.ceil((attempt.resetAt - now) / 1000);
            return res.status(429).json({
                message: `Too many login attempts. Try again in ${retryAfterSec} seconds.`
            });
        }
    }

    const username = typeof req.body.username === 'string'
        ? req.body.username.trim().toLowerCase()
        : '';
    const password = req.body.password;

    if (!username || !password) {
        return res.status(400).json({ message: "Missing username or password" });
    }

    try {
        console.log('Login attempt for username:', username);
        const admin = await prisma.admin.findFirst({
            where: {
                OR: [
                    { username },
                    { email: username }
                ]
            }
        });
        console.log('Admin found:', admin ? { adminId: admin.adminId, username: admin.username, email: admin.email } : 'none');
        if (!admin) {
            // Track failed attempt
            const entry = loginAttempts.get(clientIp) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
            entry.count++;
            loginAttempts.set(clientIp, entry);
            return res.status(401).json({ message: "Invalid credentials" });
        }

        const valid = await bcrypt.compare(password, admin.passwordHash);
        console.log('Password valid:', valid);
        if (!valid) {
            // Track failed attempt
            const entry = loginAttempts.get(clientIp) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
            entry.count++;
            loginAttempts.set(clientIp, entry);
            return res.status(401).json({ message: "Invalid credentials" });
        }

        // Successful login — clear rate limit
        loginAttempts.delete(clientIp);

        const token = jwt.sign(
            { adminId: admin.adminId, role: admin.role },
            process.env.JWT_SECRET!,
            { expiresIn: '12h' }
        );

        // Update last login
        await prisma.admin.update({ 
            where: { adminId: admin.adminId },
            data: { lastLogin: new Date() }
        });

        // Audit Log
        logAudit(admin.adminId, 'login', 'admins', `Logged in successfully`, String(admin.adminId), req.ip);

        res.json({ token, user: { username: admin.username, role: admin.role, fullName: admin.fullName, email: admin.email } });
    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

router.get('/profile', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const admin = await prisma.admin.findUnique({
            where: { adminId: req.user?.adminId },
            select: { adminId: true, username: true, role: true, email: true, createdAt: true }
        });
        res.json(admin);
    } catch (error) {
        res.status(500).json({ message: "Error fetching profile" });
    }
});

router.put('/change-password', authenticateToken, async (req: AuthRequest, res: Response) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "Current password and new password are required" });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ message: "New password must be at least 6 characters" });
    }

    try {
        const admin = await prisma.admin.findUnique({
            where: { adminId: req.user?.adminId }
        });

        if (!admin) {
            return res.status(404).json({ message: "Admin not found" });
        }

        const valid = await bcrypt.compare(currentPassword, admin.passwordHash);
        if (!valid) {
            return res.status(401).json({ message: "Current password is incorrect" });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(newPassword, salt);

        await prisma.admin.update({
            where: { adminId: admin.adminId },
            data: { passwordHash }
        });

        logAudit(admin.adminId, 'update', 'admins', 'Changed password', String(admin.adminId), req.ip);

        res.json({ message: "Password changed successfully" });
    } catch (error) {
        console.error("Change password error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

export default router;
