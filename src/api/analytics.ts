import { Router, Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../db';
import { AuthRequest, authenticateToken } from '../middleware/auth';

const router = Router();

router.use(authenticateToken);

// Helper: build date filter for pig scans
const getDateFilter = (query: any): Prisma.PigScanWhereInput => {
    const { period, startDate, endDate } = query;
    const filter: Prisma.PigScanWhereInput = {};

    if (startDate && endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.timestamp = { gte: start, lte: end };
    } else {
        const p = String(period || '30d');
        const days = parseInt(p.replace(/[^0-9]/g, '')) || 30;
        const start = new Date();
        start.setDate(start.getDate() - days);
        start.setHours(0, 0, 0, 0);
        filter.timestamp = { gte: start };
    }
    return filter;
};

// GET /trends — Pig scan trends by day
router.get('/trends', async (req: AuthRequest, res: Response) => {
    try {
        const dateFilter = getDateFilter(req.query);

        const scans = await prisma.pigScan.findMany({
            where: dateFilter,
            select: { timestamp: true }
        });

        const dayMap = new Map<string, number>();
        scans.forEach(s => {
            const d = s.timestamp.toISOString().split('T')[0];
            dayMap.set(d, (dayMap.get(d) || 0) + 1);
        });

        const trends = Array.from(dayMap.entries())
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date));

        res.json({
            success: true,
            data: { period: req.query.period || 'custom', trends, totalScans: scans.length }
        });
    } catch (error) {
        console.error("Analytics Error:", error);
        res.status(500).json({ message: "Error fetching scan trends" });
    }
});

// GET /by-type — Pig count grouped by type
router.get('/by-type', async (req: AuthRequest, res: Response) => {
    try {
        const typeStats = await prisma.pig.groupBy({
            by: ['pigType'],
            where: { deletedAt: null },
            _count: { pigId: true }
        });

        const total = typeStats.reduce((sum, t) => sum + t._count.pigId, 0);
        const types = typeStats.map(t => ({
            type: t.pigType,
            count: t._count.pigId,
            percentage: total ? ((t._count.pigId / total) * 100).toFixed(1) + '%' : '0%'
        })).sort((a, b) => b.count - a.count);

        res.json({ success: true, data: { types, totalPigs: total } });
    } catch (error) {
        console.error("Analytics Error:", error);
        res.status(500).json({ message: "Error fetching type stats" });
    }
});

// GET /by-pen — Pig count by pen with health breakdown
router.get('/by-pen', async (req: AuthRequest, res: Response) => {
    try {
        const penHealthRaw = await prisma.pig.groupBy({
            by: ['pen', 'healthStatus'],
            where: { deletedAt: null },
            _count: { pigId: true }
        });

        const penMap: Record<string, { count: number; healthy: number; atRisk: number; sick: number }> = {};
        penHealthRaw.forEach(row => {
            if (!penMap[row.pen]) {
                penMap[row.pen] = { count: 0, healthy: 0, atRisk: 0, sick: 0 };
            }
            const entry = penMap[row.pen];
            const c = row._count.pigId;
            entry.count += c;
            if (row.healthStatus === 'healthy') entry.healthy += c;
            else if (row.healthStatus === 'at-risk') entry.atRisk += c;
            else if (row.healthStatus === 'sick') entry.sick += c;
        });

        const pens = Object.entries(penMap)
            .map(([pen, data]) => ({ pen, ...data }))
            .sort((a, b) => b.count - a.count);

        res.json({ success: true, data: { pens, totalPens: pens.length } });
    } catch (error) {
        console.error("Analytics Error:", error);
        res.status(500).json({ message: "Error fetching pen stats" });
    }
});

// GET /health-trends — Health status changes over time (scan-based)
router.get('/health-trends', async (req: AuthRequest, res: Response) => {
    try {
        const dateFilter = getDateFilter(req.query);

        const scans = await prisma.pigScan.findMany({
            where: dateFilter,
            select: {
                timestamp: true,
                pig: { select: { healthStatus: true } }
            }
        });

        const dayMap = new Map<string, { healthy: number; atRisk: number; sick: number }>();
        scans.forEach(s => {
            const d = s.timestamp.toISOString().split('T')[0];
            if (!dayMap.has(d)) dayMap.set(d, { healthy: 0, atRisk: 0, sick: 0 });
            const entry = dayMap.get(d)!;
            const status = s.pig?.healthStatus;
            if (status === 'healthy') entry.healthy++;
            else if (status === 'at-risk') entry.atRisk++;
            else if (status === 'sick') entry.sick++;
        });

        const trends = Array.from(dayMap.entries())
            .map(([date, statuses]) => ({ date, ...statuses }))
            .sort((a, b) => a.date.localeCompare(b.date));

        res.json({ success: true, data: { trends } });
    } catch (error) {
        console.error("Analytics Error:", error);
        res.status(500).json({ message: "Error fetching health trends" });
    }
});

export default router;
