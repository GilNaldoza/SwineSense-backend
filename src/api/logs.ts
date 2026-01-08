import { Router, Response } from 'express';
import { UserType } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import prisma from '../db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';
import { getPaginationParams, paginate } from '../utils/pagination';
import { logAudit } from '../utils/audit';

const router = Router();
router.use(authenticateToken);

// Get Logs
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const { page, limit } = getPaginationParams(req.query);
        const { startDate, endDate, userType, department, college, location, yearLevel, search } = req.query;

        const where: Prisma.EntryLogWhereInput = { deletedAt: null };

        // Date Filtering
        if (startDate || endDate) {
            where.entryTimestamp = {};
            if (startDate) where.entryTimestamp.gte = new Date(String(startDate));
            if (endDate) where.entryTimestamp.lte = new Date(String(endDate));
        }

        // Location
        if (location) {
            where.location = String(location);
        }

        // User relational filters
        if (userType || department || college || yearLevel || search) {
            where.user = {};
            if (userType) where.user.userType = String(userType) as UserType;
            if (department) where.user.department = String(department);
            if (college) where.user.college = String(college);
            if (yearLevel) where.user.yearLevel = String(yearLevel);
            
            if (search) {
                const searchStr = String(search);
                where.user.OR = [
                    { firstName: { contains: searchStr, mode: 'insensitive' } },
                    { lastName: { contains: searchStr, mode: 'insensitive' } },
                    { idNumber: { contains: searchStr, mode: 'insensitive' } }
                ];
            }
        }

        const result = await paginate(prisma.entryLog, {
            where,
            orderBy: { entryTimestamp: 'desc' },
            include: {
                user: {
                    select: { idNumber: true, firstName: true, lastName: true, userType: true, department: true, college: true, yearLevel: true }
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

// Get Archived Logs (Soft Deleted)
router.get('/archive', requireRole('super_admin'), async (req: AuthRequest, res: Response) => {
    try {
        const { page, limit } = getPaginationParams(req.query);
        const { search } = req.query;

        const where: Prisma.EntryLogWhereInput = { 
            deletedAt: { not: null } 
        };

        if (search) {
            where.OR = [
                { user: { firstName: { contains: String(search), mode: 'insensitive' } } },
                { user: { lastName: { contains: String(search), mode: 'insensitive' } } },
                { user: { idNumber: { contains: String(search), mode: 'insensitive' } } }
            ];
        }

        const result = await paginate(prisma.entryLog, {
            where,
            orderBy: { deletedAt: 'desc' },
            include: {
                user: {
                    select: { firstName: true, lastName: true, userType: true, department: true, college: true, yearLevel: true, idNumber: true }
                },
                staff: {
                    select: { username: true } 
                }
            }
        }, { page, limit }, 'entries');

        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching archived logs" });
    }
});

// Export Archived Logs
router.get('/archive/export', requireRole('super_admin'), async (req: AuthRequest, res: Response) => {
    try {
         const where: Prisma.EntryLogWhereInput = { deletedAt: { not: null } };
         
         const logs = await prisma.entryLog.findMany({
            where,
            orderBy: { deletedAt: 'desc' },
            include: {
                user: { select: { firstName: true, lastName: true, idNumber: true, userType: true, department: true, college: true } },
                staff: { select: { username: true } }
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'export', 'entry_logs', `Exported ${logs.length} archived logs`, undefined, req.ip);
        }

        const headers = ["Deleted At", "Original Timestamp", "ID Number", "Name", "Type", "College", "Dept", "Entry Method", "Staff/Node"];
        const rows = logs.map((l: any) => {
            const userName = l.user ? `${l.user.firstName} ${l.user.lastName}` : 'Unknown';
            return [
                l.deletedAt?.toISOString(),
                l.entryTimestamp.toISOString(),
                l.user?.idNumber || 'N/A',
                userName,
                l.user?.userType || '',
                l.user?.college || '',
                l.user?.department || '',
                l.entryMethod,
                l.staff?.username || l.nodeId || 'Auto'
            ].map(f => `"${String(f || '').replace(/"/g, '""')}"`).join(",");
        });

        const csv = [headers.join(","), ...rows].join("\n");
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="archive_export.csv"');
        res.send(csv);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error exporting archive" });
    }
});

// Create Log (Manual Entry)
router.post('/', async (req: AuthRequest, res: Response) => {
    try {
        const { idNumber, entryMethod, status, entryTimestamp } = req.body;
        
        // Find user by idNumber
        const user = await prisma.user.findUnique({
            where: { idNumber: String(idNumber) }
        });

        if (!user) {
             return res.status(404).json({ message: "User not found" });
        }

        const log = await prisma.entryLog.create({
            data: {
                userId: user.userId,
                rfidTag: user.rfidTag,
                entryMethod: entryMethod || 'manual',
                status: status || 'success',
                entryTimestamp: entryTimestamp ? new Date(entryTimestamp) : new Date(),
                staffId: req.user?.adminId
            }
        });
        
        if (req.user) {
             logAudit(req.user.adminId, 'create', 'entry_logs', `Created manual log for ${idNumber}`, String(log.logId), req.ip);
        }

        res.json(log);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error creating log" });
    }
});

// Export Logs
router.get('/export', async (req: AuthRequest, res: Response) => {
    try {
        const { startDate, endDate, userType, department, college, yearLevel, location } = req.query;
        const where: Prisma.EntryLogWhereInput = { deletedAt: null };

        // Date Query
        if (startDate || endDate) {
            where.entryTimestamp = {};
            if (startDate) where.entryTimestamp.gte = new Date(String(startDate));
            if (endDate) where.entryTimestamp.lte = new Date(String(endDate));
        }

        // Location
        if (location) {
            where.location = String(location);
        }

        // Relational Query
        if (userType || department || college || yearLevel) {
            where.user = {};
            if (userType) where.user.userType = String(userType) as UserType;
            if (department) where.user.department = String(department);
            if (college) where.user.college = String(college);
            if (yearLevel) where.user.yearLevel = String(yearLevel);
        }

        const logs = await prisma.entryLog.findMany({
            where,
            orderBy: { entryTimestamp: 'desc' },
            include: {
                user: { select: { firstName: true, lastName: true, idNumber: true, userType: true, department: true, college: true, yearLevel: true } },
                staff: { select: { username: true, fullName: true } }
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'export', 'entry_logs', `Exported ${logs.length} logs`, undefined, req.ip);
        }

        const headers = ["Timestamp", "ID Number", "Name", "Type", "College", "Dept", "Year", "Location", "Method", "Status", "Staff Username", "Staff Name", "Node ID"];
        const rows = logs.map((l: any) => {
            const userName = l.user ? `${l.user.firstName} ${l.user.lastName}` : 'Unknown';
            return [
                l.entryTimestamp.toISOString(),
                l.user?.idNumber || 'N/A',
                userName,
                l.user?.userType || '',
                l.user?.college || '',
                l.user?.department || '',
                l.user?.yearLevel || '',
                l.location || '',
                l.entryMethod,
                l.status,
                l.staff?.username || '',
                l.staff?.fullName || '',
                l.nodeId || ''
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
