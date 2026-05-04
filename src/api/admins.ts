import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';

const router = Router();

// Get all admins (only super_admin can see the full list)
router.get('/', authenticateToken, requireRole('super_admin'), async (req: AuthRequest, res: Response) => {
    try {
        const admins = await prisma.admin.findMany({
            select: {
                adminId: true,
                username: true,
                fullName: true,
                email: true,
                role: true,
                createdAt: true,
                lastLogin: true
            }
        });
        res.json(admins);
    } catch (error) {
        res.status(500).json({ message: "Error fetching admins" });
    }
});

// Create new admin (first admin open registration; later only super_admin can create)
router.post('/', async (req: AuthRequest, res: Response) => {
    const rawUsername = req.body.username;
    const password = req.body.password;
    const fullName = req.body.fullName;
    const rawEmail = req.body.email;
    const role = req.body.role;

    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    const resolvedUsername = typeof rawUsername === 'string' && rawUsername.trim()
        ? rawUsername.trim().toLowerCase()
        : email;

    try {
        if (!resolvedUsername || !password || !fullName || !email) {
             return res.status(400).json({ message: "Missing required fields" });
        }

        const adminCount = await prisma.admin.count();
        const allowPublicSignup = adminCount === 0;

        if (!allowPublicSignup) {
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.split(' ')[1];
            if (!token) {
                return res.status(401).json({ message: "Authentication required" });
            }

            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
                req.user = decoded;
            } catch (err) {
                return res.status(403).json({ message: "Invalid token" });
            }

            if (!req.user || req.user.role !== 'super_admin') {
                return res.status(403).json({ message: "Forbidden" });
            }
        }

        const existing = await prisma.admin.findFirst({
            where: {
                OR: [{ username: resolvedUsername }, { email }]
            }
        });

        if (existing) {
            return res.status(409).json({ message: "Email already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newAdmin = await prisma.admin.create({
            data: {
                username: resolvedUsername,
                passwordHash: hashedPassword,
                fullName,
                email,
                role: role || (allowPublicSignup ? 'super_admin' : 'staff')
            },
            select: {
                adminId: true,
                username: true,
                role: true,
                email: true
            }
        });

        res.status(201).json(newAdmin);

    } catch (error) {
        console.error("Create admin error:", error);
        res.status(500).json({ message: "Error creating admin" });
    }
});

// Delete admin (Only super_admin)
router.delete('/:id', authenticateToken, requireRole('super_admin'), async (req: AuthRequest, res: Response) => {
    const id = Number(req.params.id);
    
    // Prevent self-deletion
    if (req.user?.adminId === id) {
        return res.status(400).json({ message: "Cannot delete yourself" });
    }

    try {
        await prisma.admin.delete({ where: { adminId: id } });
        res.sendStatus(204);
    } catch (error) {
         res.status(500).json({ message: "Error deleting admin" });
    }
});

export default router;
