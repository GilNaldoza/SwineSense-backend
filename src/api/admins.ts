import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';

const router = Router();

// Middleware: All routes require authentication
router.use(authenticateToken);

// Get all admins (only super_admin can see full list? or maybe staff too? lets say only super_admin for management)
router.get('/', requireRole('super_admin'), async (req: AuthRequest, res: Response) => {
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

// Create new admin (Only super_admin)
router.post('/', requireRole('super_admin'), async (req: AuthRequest, res: Response) => {
    const { username, password, fullName, email, role } = req.body;

    try {
        // Validation
        if (!username || !password || !fullName || !email) {
             return res.status(400).json({ message: "Missing required fields" });
        }

        // Check duplicates
        const existing = await prisma.admin.findFirst({
            where: {
                OR: [{ username }, { email }]
            }
        });

        if (existing) {
            return res.status(409).json({ message: "Username or Email already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newAdmin = await prisma.admin.create({
            data: {
                username,
                passwordHash: hashedPassword,
                fullName,
                email,
                role: role || 'staff' // Default to staff
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
router.delete('/:id', requireRole('super_admin'), async (req: AuthRequest, res: Response) => {
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
