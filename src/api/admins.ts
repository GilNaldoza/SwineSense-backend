import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';

const router = Router();

const requireSuperAdminAfterFirstAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
    const adminCount = await prisma.admin.count();
    if (adminCount === 0) return next();

    authenticateToken(req, res, () => {
        if (!req.user || req.user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Forbidden' });
        }
        next();
    });
};

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
router.post('/', requireSuperAdminAfterFirstAdmin, async (req: AuthRequest, res: Response) => {
    const { username, password, fullName, email, role } = req.body;
    const resolvedUsername = username?.trim() || email?.trim();

    try {
        if (!resolvedUsername || !password || !fullName || !email) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const existing = await prisma.admin.findFirst({
            where: {
                OR: [{ username: resolvedUsername }, { email }]
            }
        });

        if (existing) {
            return res.status(409).json({ message: 'Email already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const adminCount = await prisma.admin.count();
        const isFirstAdmin = adminCount === 0;

        const newAdmin = await prisma.admin.create({
            data: {
                username: resolvedUsername,
                passwordHash: hashedPassword,
                fullName,
                email,
                role: role || (isFirstAdmin ? 'super_admin' : 'staff')
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
        console.error('Create admin error:', error);
        res.status(500).json({ message: 'Error creating admin' });
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

// Update admin profile (super_admin can update anyone; staff can only update self)
router.put('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
    const id = Number(req.params.id);
    const { fullName, email, role } = req.body;

    // Staff can only update themselves
    if (req.user?.role !== 'super_admin' && req.user?.adminId !== id) {
        return res.status(403).json({ message: "Forbidden" });
    }

    try {
        const data: Record<string, any> = {};
        if (fullName !== undefined) data.fullName = fullName;
        if (email !== undefined) data.email = email;
        // Only super_admin can change roles
        if (role !== undefined && req.user?.role === 'super_admin') data.role = role;

        const updated = await prisma.admin.update({
            where: { adminId: id },
            data,
            select: {
                adminId: true,
                username: true,
                fullName: true,
                email: true,
                role: true,
            }
        });

        res.json(updated);
    } catch (error) {
        console.error('Update admin error:', error);
        res.status(500).json({ message: "Error updating admin" });
    }
});

export default router;
