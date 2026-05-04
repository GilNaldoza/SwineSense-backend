import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../db';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { logAudit } from '../utils/audit';

const router = Router();

router.post('/login', async (req: Request, res: Response) => {
    const username = typeof req.body.username === 'string'
        ? req.body.username.trim().toLowerCase()
        : '';
    const password = req.body.password;

    if (!username || !password) {
        return res.status(400).json({ message: "Missing username or password" });
    }

    try {
        const admin = await prisma.admin.findUnique({ where: { username } });
        if (!admin) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

        const valid = await bcrypt.compare(password, admin.passwordHash);
        if (!valid) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

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

        res.json({ token, user: { username: admin.username, role: admin.role } });
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

export default router;
