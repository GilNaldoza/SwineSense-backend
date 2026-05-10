import { Router, Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../db';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { getPaginationParams, paginate } from '../utils/pagination';
import { logAudit } from '../utils/audit';
import { broadcastSignal } from '../grpc';

const router = Router();

// Middleware
router.use(authenticateToken);

// Check RFID - returns pig if exists, or null if not
router.get('/check-rfid/:rfid', async (req: AuthRequest, res: Response) => {
    try {
        const pig = await prisma.pig.findUnique({
            where: { rfidTag: req.params.rfid, deletedAt: null }
        });
        res.json(pig || null);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error checking RFID" });
    }
});

// Get all pigs (Paginated & Filtered)
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const { page, limit } = getPaginationParams(req.query);
        const { search, pigType, pen, healthStatus } = req.query;

        const where: Prisma.PigWhereInput = { deletedAt: null };

        // Search
        if (search) {
             where.OR = [
                 { pigNumber: { contains: String(search) } },
                 { rfidTag: { contains: String(search) } },
                 { notes: { contains: String(search) } }
             ];
        }

        // Filters
        if (pigType) where.pigType = String(pigType);
        if (pen) where.pen = String(pen);
        if (healthStatus) where.healthStatus = String(healthStatus);

        const result = await paginate(prisma.pig, {
            where,
            orderBy: { updatedAt: 'desc' },
        }, { page, limit }, 'pigs');

        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching pigs" });
    }
});

// Get pig by ID
router.get('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const pigId = Number(req.params.id);
        const pig = await prisma.pig.findUnique({
            where: { pigId, deletedAt: null }
        });
        if (!pig) return res.status(404).json({ message: "Pig not found" });
        res.json(pig);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching pig" });
    }
});

// Create Pig
router.post('/', async (req: AuthRequest, res: Response) => {
    try {
        const { rfidTag, pigNumber, pigType, sire, dam, pen, healthStatus, weight, dateOfBirth, notes } = req.body;

        // Basic Validation
        if (!rfidTag || !pigNumber || !pigType || !pen || !dateOfBirth) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        const newPig = await prisma.pig.create({
            data: {
                rfidTag,
                pigNumber,
                pigType,
                sire,
                dam,
                pen,
                healthStatus: healthStatus || 'healthy',
                weight: weight ? parseFloat(weight) : null,
                dateOfBirth: new Date(dateOfBirth),
                notes
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'create', 'pigs', `Created pig ${pigNumber}`, String(newPig.pigId), req.ip);
        }

        broadcastSignal('SYNC_PIGS', `created_pig_${newPig.pigId}`);

        res.status(201).json(newPig);

    } catch (error: any) {
        if (error.code === 'P2002') { // Unique constraint violation
            return res.status(409).json({ message: "Pig with this RFID or number already exists" });
        }
        console.error(error);
        res.status(500).json({ message: "Error creating pig" });
    }
});

// Update Pig
router.put('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const pigId = Number(req.params.id);
        const data = req.body;

        // Handle dateOfBirth
        if (data.dateOfBirth) {
            data.dateOfBirth = new Date(data.dateOfBirth);
        }

        // Handle weight
        if (data.weight) {
            data.weight = parseFloat(data.weight);
        }

        const updatedPig = await prisma.pig.update({
            where: { pigId },
            data: {
                ...data,
                updatedAt: new Date()
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'update', 'pigs', `Updated pig ${updatedPig.pigNumber}`, String(pigId), req.ip);
        }

        broadcastSignal('SYNC_PIGS', `updated_pig_${pigId}`);

        res.json(updatedPig);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error updating pig" });
    }
});

// Soft Delete Pig
router.delete('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const pigId = Number(req.params.id);

        // Soft delete
        await prisma.pig.update({
            where: { pigId },
            data: {
                deletedAt: new Date()
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'delete', 'pigs', `Soft deleted pig`, String(pigId), req.ip);
        }

        broadcastSignal('SYNC_PIGS', `deleted_pig_${pigId}`);

        res.sendStatus(204);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error deleting pig" });
    }
});

// Record Pig Scan
router.post('/scans', async (req: AuthRequest, res: Response) => {
    try {
        const { rfidTag, location, notes } = req.body;

        if (!rfidTag) {
            return res.status(400).json({ message: "RFID tag is required" });
        }

        // Find the pig
        const pig = await prisma.pig.findUnique({
            where: { rfidTag, deletedAt: null }
        });

        if (!pig) {
            return res.status(404).json({ message: "Pig not found" });
        }

        // Create scan log
        const scan = await prisma.pigScan.create({
            data: {
                pigId: pig.pigId,
                timestamp: new Date(),
                location,
                scannedBy: req.user?.adminId,
                notes
            },
            include: {
                pig: { select: { pigNumber: true, pigType: true } },
                admin: { select: { fullName: true } }
            }
        });

        // Update lastScanned
        await prisma.pig.update({
            where: { pigId: pig.pigId },
            data: { lastScanned: new Date() }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'create', 'pig_scans', `Scanned pig ${pig.pigNumber}`, String(scan.scanId), req.ip);
        }

        res.status(201).json(scan);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error recording scan" });
    }
});

// Dashboard Stats
router.get('/stats/dashboard', async (req: AuthRequest, res: Response) => {
    try {
        const totalPigs = await prisma.pig.count({ where: { deletedAt: null } });

        const healthStats = await prisma.pig.groupBy({
            by: ['healthStatus'],
            where: { deletedAt: null },
            _count: { pigId: true }
        });

        const penStats = await prisma.pig.groupBy({
            by: ['pen'],
            where: { deletedAt: null },
            _count: { pigId: true }
        });

        const typeStats = await prisma.pig.groupBy({
            by: ['pigType'],
            where: { deletedAt: null },
            _count: { pigId: true }
        });

        // Recent scans
        const recentScans = await prisma.pigScan.findMany({
            take: 10,
            orderBy: { timestamp: 'desc' },
            include: {
                pig: { select: { pigNumber: true, pigType: true } },
                admin: { select: { fullName: true } }
            }
        });

        // Scans by day for the last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const last7DaysScans = await prisma.pigScan.findMany({
            where: { timestamp: { gte: sevenDaysAgo } },
            select: { timestamp: true }
        });

        const scansByDayMap: Record<string, number> = {};
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            scansByDayMap[dateStr] = 0;
        }

        last7DaysScans.forEach(scan => {
            const dateStr = scan.timestamp.toISOString().split('T')[0];
            if (scansByDayMap[dateStr] !== undefined) {
                scansByDayMap[dateStr]++;
            }
        });

        const scansByDay = Object.keys(scansByDayMap).map(date => ({
            date,
            count: scansByDayMap[date]
        }));

        res.json({
            totalPigs,
            healthStats,
            penStats,
            typeStats,
            recentScans,
            scansByDay
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching dashboard stats" });
    }
});

// Recent Scans
router.get('/scans/recent', async (req: AuthRequest, res: Response) => {
    try {
        const { limit = 20 } = req.query;
        const scans = await prisma.pigScan.findMany({
            take: Number(limit),
            orderBy: { timestamp: 'desc' },
            include: {
                pig: { select: { pigNumber: true, pigType: true, pen: true } },
                admin: { select: { fullName: true } }
            }
        });
        res.json(scans);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching recent scans" });
    }
});

// Export Pigs
router.get('/export', async (req: AuthRequest, res: Response) => {
    try {
        const { search, pigType, pen, healthStatus } = req.query;
        const where: Prisma.PigWhereInput = { deletedAt: null };

        // Filters
        if (search) {
             where.OR = [
                 { pigNumber: { contains: String(search) } },
                 { rfidTag: { contains: String(search) } }
             ];
        }
        if (pigType) where.pigType = String(pigType);
        if (pen) where.pen = String(pen);
        if (healthStatus) where.healthStatus = String(healthStatus);

        const pigs = await prisma.pig.findMany({
            where,
            orderBy: { pigNumber: 'asc' }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'export', 'pigs', `Exported ${pigs.length} pigs`, undefined, req.ip);
        }

        // CSV Generation
        const headers = ["Pig Number", "RFID Tag", "Type", "Pen", "Health Status", "Weight", "Date of Birth", "Sire", "Dam", "Notes"];
        const rows = pigs.map((p: any) => [
            p.pigNumber, p.rfidTag, p.pigType, p.pen, p.healthStatus, p.weight, p.dateOfBirth?.toISOString().split('T')[0], p.sire, p.dam, p.notes
        ].map(f => `"${String(f || '').replace(/"/g, '""')}"`).join(","));

        const csv = [headers.join(","), ...rows].join("\n");

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="pigs_export.csv"');
        res.send(csv);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Export failed" });
    }
});

export default router;