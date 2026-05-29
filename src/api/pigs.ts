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

        // Per-pen health breakdown (groups by both pen AND healthStatus)
        const penHealthRaw = await prisma.pig.groupBy({
            by: ['pen', 'healthStatus'],
            where: { deletedAt: null },
            _count: { pigId: true }
        });

        // Aggregate into per-pen summary
        const penMap: Record<string, { count: number; healthy: number; atRisk: number; sick: number }> = {};
        penHealthRaw.forEach((row) => {
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
        const penStats = Object.entries(penMap).map(([pen, data]) => ({ pen, ...data }));

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

// Get paginated pig scans
router.get('/scans', async (req: AuthRequest, res: Response) => {
    try {
        const { page, limit } = getPaginationParams(req.query);
        const { search, location, startDate, endDate } = req.query;

        const where: Prisma.PigScanWhereInput = {};

        // Search by Pig Number or RFID
        if (search) {
            where.pig = {
                OR: [
                    { pigNumber: { contains: String(search) } },
                    { rfidTag: { contains: String(search) } }
                ]
            };
        }

        // Filters
        if (location) where.location = String(location);
        
        if (startDate || endDate) {
            where.timestamp = {};
            if (startDate) where.timestamp.gte = new Date(String(startDate));
            if (endDate) {
                const end = new Date(String(endDate));
                end.setHours(23, 59, 59, 999);
                where.timestamp.lte = end;
            }
        }

        const result = await paginate(prisma.pigScan, {
            where,
            orderBy: { timestamp: 'desc' },
            include: {
                pig: { select: { pigNumber: true, pigType: true, pen: true, rfidTag: true } },
                admin: { select: { fullName: true } }
            }
        }, { page, limit }, 'scans');

        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching pig scans" });
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

// Export Pig Scans as CSV
router.get('/scans/export', async (req: AuthRequest, res: Response) => {
    try {
        const { search, location, startDate, endDate } = req.query;
        const where: Prisma.PigScanWhereInput = {};

        if (search) {
            where.pig = {
                OR: [
                    { pigNumber: { contains: String(search) } },
                    { rfidTag: { contains: String(search) } }
                ]
            };
        }
        if (location) where.location = String(location);
        if (startDate || endDate) {
            where.timestamp = {};
            if (startDate) where.timestamp.gte = new Date(String(startDate));
            if (endDate) {
                const end = new Date(String(endDate));
                end.setHours(23, 59, 59, 999);
                where.timestamp.lte = end;
            }
        }

        const scans = await prisma.pigScan.findMany({
            where,
            orderBy: { timestamp: 'desc' },
            include: {
                pig: { select: { pigNumber: true, pigType: true, pen: true, rfidTag: true } },
                admin: { select: { fullName: true } }
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'export', 'pig_scans', `Exported ${scans.length} scans`, undefined, req.ip);
        }

        const headers = ["Pig Number", "RFID Tag", "Type", "Pen", "Scan Time", "Location", "Scanned By", "Notes"];
        const rows = scans.map((s: any) => [
            s.pig?.pigNumber, s.pig?.rfidTag, s.pig?.pigType, s.pig?.pen,
            s.timestamp?.toISOString(), s.location, s.admin?.fullName, s.notes
        ].map(f => `"${String(f || '').replace(/"/g, '""')}"`).join(","));

        const csv = [headers.join(","), ...rows].join("\n");

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="pig_scans_export.csv"');
        res.send(csv);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Scan export failed" });
    }
});

// Record a health status change for a pig
router.post('/:id/health', async (req: AuthRequest, res: Response) => {
    try {
        const pigId = Number(req.params.id);
        const { newStatus, reason } = req.body;

        if (!newStatus || !['healthy', 'at-risk', 'sick'].includes(newStatus)) {
            return res.status(400).json({ message: "Invalid health status. Must be: healthy, at-risk, sick" });
        }

        const pig = await prisma.pig.findUnique({ where: { pigId, deletedAt: null } });
        if (!pig) return res.status(404).json({ message: "Pig not found" });

        const previousStatus = pig.healthStatus;

        // Skip if status hasn't changed
        if (previousStatus === newStatus) {
            return res.status(200).json({ message: "Status unchanged", healthStatus: newStatus });
        }

        // Create health log entry and update pig status atomically
        const [healthLog] = await prisma.$transaction([
            prisma.healthLog.create({
                data: {
                    pigId,
                    previousStatus,
                    newStatus,
                    reason,
                    recordedBy: req.user?.adminId,
                },
                include: { admin: { select: { fullName: true } } }
            }),
            prisma.pig.update({
                where: { pigId },
                data: { healthStatus: newStatus }
            })
        ]);

        if (req.user) {
            logAudit(req.user.adminId, 'update', 'pigs', `Changed health ${previousStatus} → ${newStatus} for pig ${pig.pigNumber}`, String(pigId), req.ip);
        }

        broadcastSignal('SYNC_PIGS', `health_updated_pig_${pigId}`);

        res.status(201).json(healthLog);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error recording health change" });
    }
});

// Get health history for a pig
router.get('/:id/health', async (req: AuthRequest, res: Response) => {
    try {
        const pigId = Number(req.params.id);
        const limit = Number(req.query.limit) || 50;

        const logs = await prisma.healthLog.findMany({
            where: { pigId },
            orderBy: { recordedAt: 'desc' },
            take: limit,
            include: { admin: { select: { fullName: true } } }
        });

        res.json(logs);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching health history" });
    }
});

// Get scan history for a specific pig
router.get('/:id/scans', async (req: AuthRequest, res: Response) => {
    try {
        const pigId = Number(req.params.id);
        const limit = Number(req.query.limit) || 50;

        const scans = await prisma.pigScan.findMany({
            where: { pigId },
            orderBy: { timestamp: 'desc' },
            take: limit,
            include: {
                admin: { select: { fullName: true } }
            }
        });

        res.json(scans);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching pig scan history" });
    }
});

// Record weight for a pig
router.post('/:id/weight', async (req: AuthRequest, res: Response) => {
    try {
        const pigId = Number(req.params.id);
        const { weight, notes } = req.body;

        if (weight === undefined || weight === null) {
            return res.status(400).json({ message: "Weight is required" });
        }

        const pig = await prisma.pig.findUnique({ where: { pigId, deletedAt: null } });
        if (!pig) return res.status(404).json({ message: "Pig not found" });

        const weightVal = parseFloat(weight);

        const weightLog = await prisma.weightLog.create({
            data: {
                pigId,
                weight: weightVal,
                recordedBy: req.user?.adminId,
                notes
            },
            include: { admin: { select: { fullName: true } } }
        });

        // Also update the pig's current weight field
        await prisma.pig.update({ where: { pigId }, data: { weight: weightVal } });

        if (req.user) {
            logAudit(req.user.adminId, 'create', 'weight_logs', `Recorded weight ${weightVal}kg for pig ${pig.pigNumber}`, String(weightLog.weightLogId), req.ip);
        }

        res.status(201).json(weightLog);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error recording weight" });
    }
});

// Get weight history for a pig
router.get('/:id/weight', async (req: AuthRequest, res: Response) => {
    try {
        const pigId = Number(req.params.id);
        const limit = Number(req.query.limit) || 50;

        const logs = await prisma.weightLog.findMany({
            where: { pigId },
            orderBy: { recordedAt: 'desc' },
            take: limit,
            include: { admin: { select: { fullName: true } } }
        });

        res.json(logs);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching weight history" });
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

// Update Pig
router.put('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const pigId = Number(req.params.id);
        const { rfidTag, pigNumber, pigType, sire, dam, pen, healthStatus, weight, dateOfBirth, notes } = req.body;

        const data: Record<string, any> = {};
        if (rfidTag !== undefined) data.rfidTag = rfidTag;
        if (pigNumber !== undefined) data.pigNumber = pigNumber;
        if (pigType !== undefined) data.pigType = pigType;
        if (sire !== undefined) data.sire = sire;
        if (dam !== undefined) data.dam = dam;
        if (pen !== undefined) data.pen = pen;
        if (healthStatus !== undefined) data.healthStatus = healthStatus;
        if (weight !== undefined) data.weight = parseFloat(weight);
        if (dateOfBirth !== undefined) data.dateOfBirth = new Date(dateOfBirth);
        if (notes !== undefined) data.notes = notes;

        const updatedPig = await prisma.pig.update({
            where: { pigId },
            data
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

// ===================== BATCH OPERATIONS =====================

// Batch update health status for multiple pigs
router.post('/batch/health', async (req: AuthRequest, res: Response) => {
    try {
        const { pigIds, healthStatus, reason } = req.body;

        if (!Array.isArray(pigIds) || pigIds.length === 0) {
            return res.status(400).json({ message: "pigIds must be a non-empty array" });
        }
        if (!healthStatus || !['healthy', 'at-risk', 'sick'].includes(healthStatus)) {
            return res.status(400).json({ message: "Invalid healthStatus" });
        }

        const pigs = await prisma.pig.findMany({
            where: { pigId: { in: pigIds.map(Number) }, deletedAt: null }
        });

        const updated: number[] = [];

        for (const pig of pigs) {
            if (pig.healthStatus !== healthStatus) {
                await prisma.$transaction([
                    prisma.healthLog.create({
                        data: {
                            pigId: pig.pigId,
                            previousStatus: pig.healthStatus,
                            newStatus: healthStatus,
                            reason: reason || `Batch update`,
                            recordedBy: req.user?.adminId,
                        }
                    }),
                    prisma.pig.update({
                        where: { pigId: pig.pigId },
                        data: { healthStatus }
                    })
                ]);
                updated.push(pig.pigId);
            }
        }

        if (req.user) {
            logAudit(req.user.adminId, 'update', 'pigs', `Batch health update to ${healthStatus} for ${updated.length} pigs`, undefined, req.ip);
        }

        broadcastSignal('SYNC_PIGS', `batch_health_update`);

        res.json({ message: `Updated ${updated.length} pigs`, updated });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Batch health update failed" });
    }
});

// Batch transfer pigs to a new pen
router.post('/batch/transfer', async (req: AuthRequest, res: Response) => {
    try {
        const { pigIds, pen } = req.body;

        if (!Array.isArray(pigIds) || pigIds.length === 0) {
            return res.status(400).json({ message: "pigIds must be a non-empty array" });
        }
        if (!pen || typeof pen !== 'string') {
            return res.status(400).json({ message: "pen must be a non-empty string" });
        }

        const result = await prisma.pig.updateMany({
            where: { pigId: { in: pigIds.map(Number) }, deletedAt: null },
            data: { pen }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'update', 'pigs', `Batch transferred ${result.count} pigs to pen ${pen}`, undefined, req.ip);
        }

        broadcastSignal('SYNC_PIGS', `batch_pen_transfer`);

        res.json({ message: `Transferred ${result.count} pigs to pen ${pen}`, count: result.count });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Batch transfer failed" });
    }
});

// CSV Import: Parse CSV text body and create pigs
router.post('/import', async (req: AuthRequest, res: Response) => {
    try {
        const { rows } = req.body;

        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ message: "rows must be a non-empty array of pig objects" });
        }

        const created: string[] = [];
        const errors: string[] = [];

        for (const row of rows) {
            try {
                const { pigNumber, rfidTag, pigType, pen, dateOfBirth, sire, dam, weight, healthStatus, notes } = row;

                if (!pigNumber || !rfidTag || !pigType || !pen || !dateOfBirth) {
                    errors.push(`Row missing required fields: ${pigNumber || 'unknown'}`);
                    continue;
                }

                // Check for duplicates
                const existing = await prisma.pig.findFirst({
                    where: {
                        OR: [{ rfidTag }, { pigNumber }],
                        deletedAt: null
                    }
                });

                if (existing) {
                    errors.push(`Duplicate: ${pigNumber} (RFID: ${rfidTag})`);
                    continue;
                }

                await prisma.pig.create({
                    data: {
                        pigNumber,
                        rfidTag,
                        pigType,
                        pen,
                        dateOfBirth: new Date(dateOfBirth),
                        sire: sire || null,
                        dam: dam || null,
                        weight: weight ? parseFloat(weight) : null,
                        healthStatus: healthStatus || 'healthy',
                        notes: notes || null,
                    }
                });
                created.push(pigNumber);
            } catch (rowErr: any) {
                errors.push(`Error on ${row.pigNumber || 'unknown'}: ${rowErr.message}`);
            }
        }

        if (req.user) {
            logAudit(req.user.adminId, 'create', 'pigs', `Imported ${created.length} pigs (${errors.length} errors)`, undefined, req.ip);
        }

        if (created.length > 0) {
            broadcastSignal('SYNC_PIGS', `import_${created.length}_pigs`);
        }

        res.json({ created: created.length, errors });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Import failed" });
    }
});

export default router;