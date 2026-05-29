import { Router, Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../db';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { getPaginationParams, paginate } from '../utils/pagination';
import { logAudit } from '../utils/audit';

const router = Router();

// Middleware
router.use(authenticateToken);

// Get all treatments (paginated & filtered)
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const { page, limit } = getPaginationParams(req.query);
        const { search, type, pigId, startDate, endDate } = req.query;

        const where: Prisma.TreatmentWhereInput = {};

        if (type) where.type = String(type);
        if (pigId) where.pigId = Number(pigId);

        if (search) {
            where.OR = [
                { name: { contains: String(search) } },
                { notes: { contains: String(search) } },
                { pig: { pigNumber: { contains: String(search) } } }
            ];
        }

        if (startDate || endDate) {
            where.administeredAt = {};
            if (startDate) where.administeredAt.gte = new Date(String(startDate));
            if (endDate) {
                const end = new Date(String(endDate));
                end.setHours(23, 59, 59, 999);
                where.administeredAt.lte = end;
            }
        }

        const result = await paginate(prisma.treatment, {
            where,
            orderBy: { administeredAt: 'desc' },
            include: {
                pig: { select: { pigNumber: true, pigType: true, pen: true } },
                admin: { select: { fullName: true } }
            }
        }, { page, limit }, 'treatments');

        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching treatments" });
    }
});

// Get upcoming treatments (next due dates)
router.get('/upcoming', async (req: AuthRequest, res: Response) => {
    try {
        const days = Number(req.query.days) || 7;
        const now = new Date();
        const futureDate = new Date();
        futureDate.setDate(now.getDate() + days);

        const treatments = await prisma.treatment.findMany({
            where: {
                nextDueDate: {
                    gte: new Date(now.toISOString().split('T')[0]), // start of today
                    lte: futureDate
                }
            },
            orderBy: { nextDueDate: 'asc' },
            include: {
                pig: { select: { pigNumber: true, pigType: true, pen: true, deletedAt: true } },
                admin: { select: { fullName: true } }
            }
        });

        // Filter out deleted pigs
        const active = treatments.filter(t => !t.pig.deletedAt);

        // Also get overdue treatments
        const overdue = await prisma.treatment.findMany({
            where: {
                nextDueDate: {
                    lt: new Date(now.toISOString().split('T')[0])
                }
            },
            orderBy: { nextDueDate: 'asc' },
            include: {
                pig: { select: { pigNumber: true, pigType: true, pen: true, deletedAt: true } },
                admin: { select: { fullName: true } }
            }
        });

        const activeOverdue = overdue.filter(t => !t.pig.deletedAt);

        res.json({ upcoming: active, overdue: activeOverdue });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching upcoming treatments" });
    }
});

// Create a treatment
router.post('/', async (req: AuthRequest, res: Response) => {
    try {
        const { pigId, type, name, dosage, administeredAt, nextDueDate, notes } = req.body;

        if (!pigId || !type || !name || !administeredAt) {
            return res.status(400).json({ message: "Missing required fields: pigId, type, name, administeredAt" });
        }

        if (!['vaccination', 'deworming', 'medication', 'checkup'].includes(type)) {
            return res.status(400).json({ message: "Invalid type. Must be: vaccination, deworming, medication, checkup" });
        }

        const pig = await prisma.pig.findUnique({ where: { pigId: Number(pigId), deletedAt: null } });
        if (!pig) return res.status(404).json({ message: "Pig not found" });

        const treatment = await prisma.treatment.create({
            data: {
                pigId: Number(pigId),
                type,
                name,
                dosage,
                administeredAt: new Date(administeredAt),
                nextDueDate: nextDueDate ? new Date(nextDueDate) : null,
                administeredBy: req.user?.adminId,
                notes
            },
            include: {
                pig: { select: { pigNumber: true, pigType: true, pen: true } },
                admin: { select: { fullName: true } }
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'create', 'treatments', `Recorded ${type}: ${name} for pig ${pig.pigNumber}`, String(treatment.treatmentId), req.ip);
        }

        res.status(201).json(treatment);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error recording treatment" });
    }
});

// Get treatments for a specific pig
router.get('/pig/:pigId', async (req: AuthRequest, res: Response) => {
    try {
        const pigId = Number(req.params.pigId);
        const limit = Number(req.query.limit) || 50;

        const treatments = await prisma.treatment.findMany({
            where: { pigId },
            orderBy: { administeredAt: 'desc' },
            take: limit,
            include: {
                admin: { select: { fullName: true } }
            }
        });

        res.json(treatments);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching treatments" });
    }
});

// Update a treatment
router.put('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const treatmentId = Number(req.params.id);
        const { type, name, dosage, administeredAt, nextDueDate, notes } = req.body;

        const data: Record<string, any> = {};
        if (type !== undefined) data.type = type;
        if (name !== undefined) data.name = name;
        if (dosage !== undefined) data.dosage = dosage;
        if (administeredAt !== undefined) data.administeredAt = new Date(administeredAt);
        if (nextDueDate !== undefined) data.nextDueDate = nextDueDate ? new Date(nextDueDate) : null;
        if (notes !== undefined) data.notes = notes;

        const treatment = await prisma.treatment.update({
            where: { treatmentId },
            data,
            include: {
                pig: { select: { pigNumber: true } },
                admin: { select: { fullName: true } }
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'update', 'treatments', `Updated treatment ${name || treatment.name} for pig ${treatment.pig.pigNumber}`, String(treatmentId), req.ip);
        }

        res.json(treatment);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error updating treatment" });
    }
});

// Delete a treatment
router.delete('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const treatmentId = Number(req.params.id);

        const treatment = await prisma.treatment.findUnique({
            where: { treatmentId },
            include: { pig: { select: { pigNumber: true } } }
        });

        if (!treatment) return res.status(404).json({ message: "Treatment not found" });

        await prisma.treatment.delete({ where: { treatmentId } });

        if (req.user) {
            logAudit(req.user.adminId, 'delete', 'treatments', `Deleted treatment ${treatment.name} for pig ${treatment.pig.pigNumber}`, String(treatmentId), req.ip);
        }

        res.sendStatus(204);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error deleting treatment" });
    }
});

// Export treatments as CSV
router.get('/export', async (req: AuthRequest, res: Response) => {
    try {
        const { search, type, pigId, startDate, endDate } = req.query;
        const where: Prisma.TreatmentWhereInput = {};

        if (type) where.type = String(type);
        if (pigId) where.pigId = Number(pigId);
        if (search) {
            where.OR = [
                { name: { contains: String(search) } },
                { pig: { pigNumber: { contains: String(search) } } }
            ];
        }
        if (startDate || endDate) {
            where.administeredAt = {};
            if (startDate) where.administeredAt.gte = new Date(String(startDate));
            if (endDate) {
                const end = new Date(String(endDate));
                end.setHours(23, 59, 59, 999);
                where.administeredAt.lte = end;
            }
        }

        const treatments = await prisma.treatment.findMany({
            where,
            orderBy: { administeredAt: 'desc' },
            include: {
                pig: { select: { pigNumber: true, pigType: true, pen: true } },
                admin: { select: { fullName: true } }
            }
        });

        if (req.user) {
            logAudit(req.user.adminId, 'export', 'treatments', `Exported ${treatments.length} treatments`, undefined, req.ip);
        }

        const headers = ["Pig Number", "Type", "Name", "Dosage", "Administered At", "Next Due", "Administered By", "Notes"];
        const rows = treatments.map((t: any) => [
            t.pig?.pigNumber, t.type, t.name, t.dosage,
            t.administeredAt?.toISOString(), t.nextDueDate?.toISOString()?.split('T')[0],
            t.admin?.fullName, t.notes
        ].map(f => `"${String(f || '').replace(/"/g, '""')}"`).join(","));

        const csv = [headers.join(","), ...rows].join("\n");

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="treatments_export.csv"');
        res.send(csv);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Treatment export failed" });
    }
});

export default router;
