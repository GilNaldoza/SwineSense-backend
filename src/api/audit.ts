import { Router, Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';
import { getPaginationParams, paginate } from '../utils/pagination';

const router = Router();

router.use(authenticateToken);
router.use(requireRole('super_admin'));

router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const { page, limit } = getPaginationParams(req.query);
        const { adminId, actionType, targetTable, startDate, endDate } = req.query;

        const where: Prisma.AuditLogWhereInput = {};
        
        if (adminId) where.adminId = Number(adminId);
        if (actionType) where.actionType = String(actionType);
        if (targetTable) where.targetTable = String(targetTable);
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) where.createdAt.gte = new Date(String(startDate));
            if (endDate) where.createdAt.lte = new Date(String(endDate));
        }

        const result = await paginate(prisma.auditLog, {
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                admin: { select: { username: true, role: true } }
            }
        }, { page, limit }, 'audits');

        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching audit logs" });
    }
});

router.get('/export', async (req: AuthRequest, res: Response) => {
    try {
        const { adminId, actionType, targetTable, startDate, endDate } = req.query;
        const where: Prisma.AuditLogWhereInput = {};
        
        if (adminId) where.adminId = Number(adminId);
        if (actionType) where.actionType = String(actionType);
        if (targetTable) where.targetTable = String(targetTable);
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) where.createdAt.gte = new Date(String(startDate));
            if (endDate) where.createdAt.lte = new Date(String(endDate));
        }

        const audits = await prisma.auditLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: { admin: { select: { username: true } } }
        });

        const headers = ["Timestamp", "Admin", "Action", "Target Table", "Target ID", "Description", "IP Address"];
        const rows = audits.map((a: any) => [
            a.createdAt.toISOString(),
            a.admin?.username || 'Unknown',
            a.actionType,
            a.targetTable,
            a.targetId,
            a.description,
            a.ipAddress
        ].map(f => `"${String(f || '').replace(/"/g, '""')}"`).join(","));

        const csv = [headers.join(","), ...rows].join("\n");

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="audit_export.csv"');
        res.send(csv);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Export failed" });
    }
});

export default router;
