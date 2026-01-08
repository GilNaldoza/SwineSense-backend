import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../db';
import { AuthRequest, authenticateToken } from '../middleware/auth';

const router = Router();

router.use(authenticateToken);

const getDateFilter = (query: any) => {
    const { period, startDate, endDate } = query;
    let start = new Date();
    let end = new Date();

    if (startDate && endDate) {
        start = new Date(startDate);
        end = new Date(endDate);
        // Ensure end date includes the full day
        end.setHours(23, 59, 59, 999);
    } else {
        // Defaults: '30d' -> 30 days
        const p = String(period || '30d');
        const days = parseInt(p.replace(/[^0-9]/g, '')) || 30;
        start.setDate(start.getDate() - days);
        start.setHours(0, 0, 0, 0);
    }
    return { entryTimestamp: { gte: start, lte: end } };
};

// GET /trends
router.get('/trends', async (req: AuthRequest, res: Response) => {
    try {
        const where: Prisma.EntryLogWhereInput = { 
            deletedAt: null,
            ...getDateFilter(req.query)
        };
        
        if (req.query.userType && req.query.userType !== 'all') {
            where.user = { userType: String(req.query.userType) as any };
        }

        const logs = await prisma.entryLog.findMany({
            where,
            select: { entryTimestamp: true }
        });

        const dayMap = new Map<string, number>();
        logs.forEach(l => {
            const d = l.entryTimestamp.toISOString().split('T')[0]; // YYYY-MM-DD
            dayMap.set(d, (dayMap.get(d) || 0) + 1);
        });

        const trends = Array.from(dayMap.entries())
            .map(([date, count]) => ({ date, count, label: date }))
            .sort((a, b) => a.date.localeCompare(b.date));

        res.json({
            success: true,
            data: {
                period: req.query.period || 'custom',
                trends,
                totalEntries: logs.length
            }
        });
    } catch (error) {
        console.error("Analytics Error:", error);
        res.status(500).json({ message: "Error fetching trends" });
    }
});

// GET /by-college
router.get('/by-college', async (req: AuthRequest, res: Response) => {
    try {
        const where: Prisma.EntryLogWhereInput = { 
            deletedAt: null, 
            ...getDateFilter(req.query) 
        };

        const logs = await prisma.entryLog.findMany({
            where,
            select: { user: { select: { college: true } } }
        });

        const map = new Map<string, number>();
        let total = 0;
        logs.forEach(l => {
            const c = l.user?.college || 'Unknown';
            map.set(c, (map.get(c) || 0) + 1);
            total++;
        });

        const colleges = Array.from(map.entries())
            .map(([college, count]) => ({
                college,
                count,
                percentage: total ? ((count / total) * 100).toFixed(1) + '%' : '0%'
            }))
            .sort((a, b) => b.count - a.count);

        res.json({
            success: true,
            data: { colleges, totalEntries: total }
        });
    } catch (error) {
        console.error("Analytics Error:", error);
        res.status(500).json({ message: "Error fetching college stats" });
    }
});

// GET /by-department
router.get('/by-department', async (req: AuthRequest, res: Response) => {
    try {
        const { college } = req.query;
        const where: Prisma.EntryLogWhereInput = { 
            deletedAt: null, 
            ...getDateFilter(req.query) 
        };

        if (college) {
            where.user = { college: String(college) };
        }

        const logs = await prisma.entryLog.findMany({
            where,
            select: { user: { select: { department: true, college: true } } }
        });

        const map = new Map<string, number>(); // dept -> count
        const deptToCollege = new Map<string, string>(); // dept -> college
        let total = 0;

        logs.forEach(l => {
            const d = l.user?.department || 'Unknown';
            map.set(d, (map.get(d) || 0) + 1);
            if (l.user?.college) deptToCollege.set(d, l.user.college);
            total++;
        });

        const departments = Array.from(map.entries())
            .map(([department, count]) => ({
                department,
                college: deptToCollege.get(department) || 'Unknown',
                count,
                percentage: total ? ((count / total) * 100).toFixed(1) + '%' : '0%'
            }))
            .sort((a, b) => b.count - a.count);

        res.json({
            success: true,
            data: { departments, totalEntries: total }
        });
    } catch (error) {
        console.error("Analytics Error:", error);
        res.status(500).json({ message: "Error fetching department stats" });
    }
});

// GET /time-by-college
router.get('/time-by-college', async (req: AuthRequest, res: Response) => {
    try {
        const where: Prisma.EntryLogWhereInput = { 
            deletedAt: null, 
            ...getDateFilter(req.query) 
        };

        const logs = await prisma.entryLog.findMany({
            where,
            select: { entryTimestamp: true, user: { select: { college: true } } }
        });

        const dateMap = new Map<string, Record<string, any>>();
        const allColleges = new Set<string>();

        logs.forEach(l => {
            const date = l.entryTimestamp.toISOString().split('T')[0];
            const college = l.user?.college || 'Unknown';
            allColleges.add(college);

            if (!dateMap.has(date)) {
                dateMap.set(date, { date });
            }
            const record = dateMap.get(date)!;
            record[college] = (record[college] || 0) + 1;
        });

        // Fill missing zeros if needed? Frontend usually handles missing keys or we can pre-fill.
        // Frontend Recharts handles missing keys gracefully usually.

        const data = Array.from(dateMap.values())
            .sort((a, b) => a.date.localeCompare(b.date));

        res.json({
            success: true,
            data: {
                period: req.query.period || 'custom',
                categories: Array.from(allColleges),
                data
            }
        });
    } catch (error) {
        console.error("Analytics Error:", error);
        res.status(500).json({ message: "Error fetching time stats" });
    }
});

// GET /peak-hours
router.get('/peak-hours', async (req: AuthRequest, res: Response) => {
    try {
        // usually peak hours is over All Time or last X days? Let's assume Last 30 days default if no filter
        const where: Prisma.EntryLogWhereInput = {
            deletedAt: null,
            ...getDateFilter({ ...req.query, period: req.query.period || '30d' })
        };

        const logs = await prisma.entryLog.findMany({
            where,
            select: { entryTimestamp: true }
        });

        const hourMap = new Array(24).fill(0);
        logs.forEach(l => {
            const h = new Date(l.entryTimestamp).getHours();
            hourMap[h]++;
        });

        const peakHours = hourMap.map((count, hour) => ({
            hour,
            count,
            label: `${hour}:00`
        }));

        const max = Math.max(...hourMap);
        const peakHourIdx = hourMap.indexOf(max);

        res.json({
            success: true,
            data: {
                peakHours,
                peakHour: { hour: peakHourIdx, count: max, label: `${peakHourIdx}:00` }
            }
        });
    } catch (error) {
        console.error("Analytics Error:", error);
        res.status(500).json({ message: "Error fetching peak hours" });
    }
});

export default router;
