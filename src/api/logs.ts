import { Router, Response } from 'express';
import { UserType } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import prisma from '../db';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { getPaginationParams, paginate } from '../utils/pagination';
import { logAudit } from '../utils/audit';

const router = Router();
router.use(authenticateToken);

// Get Logs
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const { page, limit } = getPaginationParams(req.query);
        const { startDate, endDate, userType, department, college } = req.query;

        const where: Prisma.EntryLogWhereInput = { deletedAt: null };

        // Date Filtering
        if (startDate || endDate) {
            where.entryTimestamp = {};
            if (startDate) where.entryTimestamp.gte = new Date(String(startDate));
            if (endDate) where.entryTimestamp.lte = new Date(String(endDate));
        }

        // User relational filters
        if (userType || department || college) {
            where.user = {};
            if (userType) where.user.userType = String(userType) as UserType;
            if (department) where.user.department = String(department);
            if (college) where.user.college = String(college);
        }

        const result = await paginate(prisma.entryLog, {
            where,
            orderBy: { entryTimestamp: 'desc' },
            include: {
                user: {
                    select: { firstName: true, lastName: true, userType: true, department: true, college: true }
                },
                staff: {
                    select: { username: true } 
                }
            }
        }, { page, limit }, 'entries');

        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching logs" });
    }
});

// Export Logs
router.get('/export', async (req: AuthRequest, res: Response) => {
    try {
        const { startDate, endDate, userType, department, college } = req.query;
        const where: Prisma.EntryLogWhereInput = { deletedAt: null };

        // Date Query
        if (startDate || endDate) {
            where.entryTimestamp = {};
            if (startDate) where.entryTimestamp.gte = new Date(String(startDate));
            if (endDate) where.entryTimestamp.lte = new Date(String(endDate));
        }

        // Relational Query
        if (userType || department || college) {
            where.user = {};
            if (userType) where.user.userType = String(userType) as UserType;
            if (department) where.user.department = String(department);
            if (college) where.user.college = String(college);
        }

        const logs = await prisma.entryLog.findMany({
            where,
            orderBy: { entryTimestamp: 'desc' },
            include: {
                user: { select: { firstName: true, lastName: true, idNumber: true, userType: true, department: true, college: true } },
                staff: { select: { username: true } }
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'export', 'entry_logs', `Exported ${logs.length} logs`, undefined, req.ip);
        }

        const headers = ["Timestamp", "ID Number", "Name", "Type", "College", "Dept", "Method", "Status", "Staff/Node"];
        const rows = logs.map((l: any) => {
            const userName = l.user ? `${l.user.firstName} ${l.user.lastName}` : 'Unknown';
            return [
                l.entryTimestamp.toISOString(),
                l.user?.idNumber || 'N/A',
                userName,
                l.user?.userType || '',
                l.user?.college || '',
                l.user?.department || '',
                l.entryMethod,
                l.status,
                l.staff?.username || l.nodeId || 'Auto'
            ].map(f => `"${String(f || '').replace(/"/g, '""')}"`).join(",");
        });

        const csv = [headers.join(","), ...rows].join("\n");
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="logs_export.csv"');
        res.send(csv);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Export error" });
    }
});

// Update Log
router.put('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const logId = Number(req.params.id);
        const { entryTimestamp, entryMethod, status } = req.body;

        const updated = await prisma.entryLog.update({
            where: { logId },
            data: {
                entryTimestamp: entryTimestamp ? new Date(entryTimestamp) : undefined,
                entryMethod,
                status,
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'update', 'entry_logs', `Updated log ${logId}`, String(logId), req.ip);
        }
        
        res.json(updated);
    } catch (error) {
        console.error("Error updating log:", error);
        res.status(500).json({ message: "Error updating log" });
    }
});

// Delete Log (Soft)
router.delete('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const logId = Number(req.params.id);
        
        // Soft delete
        await prisma.entryLog.update({
            where: { logId },
            data: { deletedAt: new Date() }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'delete', 'entry_logs', `Soft deleted log ${logId}`, String(logId), req.ip);
        }
        
        res.sendStatus(204);
    } catch (error) {
        console.error("Error deleting log:", error);
        res.status(500).json({ message: "Error deleting log" });
    }
});

export default router;
