import { Router, Response } from 'express';
import { UserType } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import prisma from '../db';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { getPaginationParams, paginate } from '../utils/pagination';
import { logAudit } from '../utils/audit';
import { broadcastSignal } from '../grpc';

const router = Router();

// Middleware
router.use(authenticateToken);

// Get all users (Paginated & Filtered)
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const { page, limit } = getPaginationParams(req.query);
        const { search, userType, department, college, yearLevel, status } = req.query;

        const where: Prisma.UserWhereInput = { deletedAt: null };
        
        // Search
        if (search) {
             where.OR = [
                 { firstName: { contains: String(search), mode: 'insensitive' } },
                 { lastName: { contains: String(search), mode: 'insensitive' } },
                 { idNumber: { contains: String(search), mode: 'insensitive' } },
                 { rfidTag: { contains: String(search), mode: 'insensitive' } }
             ];
        }

        // Filters
        if (userType) where.userType = String(userType) as UserType;
        if (department) where.department = String(department);
        if (college) where.college = String(college);
        if (yearLevel) where.yearLevel = String(yearLevel);
        if (status) where.status = String(status);

        const result = await paginate(prisma.user, {
            where,
            orderBy: { updatedAt: 'desc' },
        }, { page, limit }, 'users');

        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching users" });
    }
});

// Export Users
router.get('/export', async (req: AuthRequest, res: Response) => {
    try {
        const { search, userType, department, college } = req.query;
        const where: Prisma.UserWhereInput = { deletedAt: null };

        // Filters
        if (search) {
             where.OR = [
                 { firstName: { contains: String(search), mode: 'insensitive' } },
                 { lastName: { contains: String(search), mode: 'insensitive' } },
                 { idNumber: { contains: String(search), mode: 'insensitive' } }
             ];
        }
        if (userType) where.userType = String(userType) as UserType;
        if (department) where.department = String(department);
        if (college) where.college = String(college);

        const users = await prisma.user.findMany({ 
            where, 
            orderBy: { lastName: 'asc' } 
        });

        if (req.user) {
            logAudit(req.user.adminId, 'export', 'users', `Exported ${users.length} users`, undefined, req.ip);
        }

        // CSV Generation
        const headers = ["ID Number", "First Name", "Last Name", "Type", "College", "Department", "Year Level", "Status"];
        const rows = users.map((u: any) => [
            u.idNumber, u.firstName, u.lastName, u.userType, u.college, u.department, u.yearLevel, u.status
        ].map(f => `"${String(f || '').replace(/"/g, '""')}"`).join(","));

        const csv = [headers.join(","), ...rows].join("\n");

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="users_export.csv"');
        res.send(csv);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Export failed" });
    }
});

// Create User
router.post('/', async (req: AuthRequest, res: Response) => {
    try {
        const { idNumber, rfidTag, firstName, lastName, email, userType, college, department, yearLevel } = req.body;
        
        // Basic Validation
        if (!idNumber || !rfidTag || !firstName || !lastName || !userType) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        const newUser = await prisma.user.create({
            data: {
                idNumber,
                rfidTag,
                firstName,
                lastName,
                email,
                userType,
                college,
                department,
                yearLevel,
                status: 'active'
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'create', 'users', `Created user ${firstName} ${lastName}`, String(newUser.userId), req.ip);
        }

        broadcastSignal('SYNC_USERS', `created_user_${newUser.userId}`);

        res.status(201).json(newUser);

    } catch (error: any) {
        if (error.code === 'P2002') { // Unique constraint violation
            return res.status(409).json({ message: "User with this ID or RFID already exists" });
        }
        console.error(error);
        res.status(500).json({ message: "Error creating user" });
    }
});

// Update User
router.put('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const userId = Number(req.params.id);
        const data = req.body;
        
        const updatedUser = await prisma.user.update({
            where: { userId },
            data: {
                ...data,
                updatedAt: new Date()
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'update', 'users', `Updated user ${updatedUser.idNumber}`, String(userId), req.ip);
        }
        
        broadcastSignal('SYNC_USERS', `updated_user_${userId}`);

        res.json(updatedUser);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error updating user" });
    }
});

// Soft Delete User
router.delete('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const userId = Number(req.params.id);
        
        // Soft delete
        await prisma.user.update({
            where: { userId },
            data: { 
                deletedAt: new Date(),
                status: 'inactive'
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'delete', 'users', `Soft deleted user`, String(userId), req.ip);
        }
        
        broadcastSignal('SYNC_USERS', `deleted_user_${userId}`);

        res.sendStatus(204);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error deleting user" });
    }
});

// Get User by RFID (Legacy support / specific lookup)
router.get('/:rfid', async (req: AuthRequest, res: Response) => {
    try {
        const user = await prisma.user.findUnique({
            where: { rfidTag: req.params.rfid }
        });
        if (!user) return res.status(404).json({ message: "User not found" });
        res.json(user);
    } catch (error) {
        res.status(500).json({ message: "Error fetching user" });
    }
});

export default router;
