import prisma from '../db';

export const logAudit = async (
    adminId: number, 
    actionType: string, 
    targetTable: string, 
    description: string, 
    targetId?: string | number,
    ipAddress?: string
) => {
    // Fire and forget - don't block the main request
    try {
        await prisma.auditLog.create({
            data: {
                adminId,
                actionType,
                targetTable,
                description,
                targetId: targetId ? String(targetId) : null,
                ipAddress: ipAddress || null
            }
        });
    } catch (err) {
        console.error("Failed to write audit log:", err);
    }
};
