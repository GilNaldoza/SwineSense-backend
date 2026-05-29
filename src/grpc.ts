import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import type { Prisma } from '@prisma/client';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import prisma from './db';

dotenv.config();

const PROTO_PATH = path.join(__dirname, 'proto/lens.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

const lensProto = grpc.loadPackageDefinition(packageDefinition).lens as any;

// Store active streams: Map<node_id, call>
const activeStreams = new Map<string, any>();

export const broadcastSignal = (command: string, payload: string) => {
    console.log(`Broadcasting signal: ${command}`);
    for (const [nodeId, call] of activeStreams.entries()) {
        try {
            call.write({ command, payload });
        } catch (error) {
            console.error(`Failed to send signal to ${nodeId}`, error);
            activeStreams.delete(nodeId);
        }
    }
};

const verifyToken = (token: string): { adminId: number, role: string } => {
    if (!process.env.JWT_SECRET) throw new Error("Server misconfiguration");
    return jwt.verify(token, process.env.JWT_SECRET) as { adminId: number, role: string };
};

const getTokenFromMetadata = (call: any): string => {
    const metadataValue = call.metadata?.get('token');
    if (Array.isArray(metadataValue) && metadataValue.length > 0) {
        return String(metadataValue[0]);
    }
    return '';
};

const getAuthToken = (call: any): string => {
    return call.request?.token || getTokenFromMetadata(call);
};

const login = async (call: any, callback: any) => {
    const { username, password } = call.request;
    
    try {
        const admin = await prisma.admin.findFirst({
            where: {
                OR: [
                    { username },
                    { email: username }
                ]
            }
        });
        if (!admin) {
             return callback(null, { success: false, message: "Invalid credentials", token: "" });
        }

        const valid = await bcrypt.compare(password, admin.passwordHash);
        if (!valid) {
             return callback(null, { success: false, message: "Invalid credentials", token: "" });
        }

        const token = jwt.sign(
            { adminId: admin.adminId, role: admin.role },
            process.env.JWT_SECRET!,
            { expiresIn: '12h' }
        );

        callback(null, { success: true, message: "Login Successful", token });
    } catch (error) {
        console.error("Login error:", error);
        callback(null, { success: false, message: "Server error", token: "" });
    }
};

// Legacy stubs — proto still defines these RPCs for old scanner compatibility
const pushLogs = async (_call: any, callback: any) => {
    callback(null, { success: true, message: "Logs endpoint deprecated", items_processed: 0 });
};

const pullUsers = async (_call: any, callback: any) => {
    callback(null, { users: [] });
};

const pushUsers = async (_call: any, callback: any) => {
    callback(null, { success: true, message: "Users endpoint deprecated", items_processed: 0 });
};

const pullPigs = async (call: any, callback: any) => {
    const { last_sync_timestamp } = call.request;
    const token = getAuthToken(call);
    
    try {
        verifyToken(token);
        const since = last_sync_timestamp ? new Date(last_sync_timestamp) : new Date(0);
        
        const pigs = await prisma.pig.findMany({
            where: {
                updatedAt: { gt: since }
            }
        });

        const mappedPigs = pigs.map((p: any) => ({
            rfid_tag: p.rfidTag,
            pig_number: p.pigNumber,
            pig_type: p.pigType,
            sire: p.sire || "",
            dam: p.dam || "",
            pen: p.pen,
            health_status: p.healthStatus,
            weight: p.weight ? String(p.weight) : "",
            date_of_birth: p.dateOfBirth.toISOString(),
            notes: p.notes || "",
            updated_at: p.updatedAt.toISOString()
        }));

        callback(null, { pigs: mappedPigs });

    } catch (err) {
        console.error("Error pulling pigs:", err);
        callback(null, { pigs: [] });
    }
};

const pushPigs = async (call: any, callback: any) => {
    const pigs = call.request.pigs;
    const token = getTokenFromMetadata(call);

    try {
        verifyToken(token);
        let processed = 0;
        
        for (const p of pigs) {
             await prisma.pig.upsert({
                 where: { rfidTag: p.rfid_tag },
                 update: {
                     pigNumber: p.pig_number,
                     pigType: p.pig_type,
                     sire: p.sire || null,
                     dam: p.dam || null,
                     pen: p.pen,
                     healthStatus: p.health_status,
                     weight: p.weight ? parseFloat(p.weight) : null,
                     dateOfBirth: new Date(p.date_of_birth),
                     notes: p.notes || null,
                     updatedAt: new Date(p.updated_at || new Date())
                 },
                 create: {
                     rfidTag: p.rfid_tag,
                     pigNumber: p.pig_number,
                     pigType: p.pig_type,
                     sire: p.sire || null,
                     dam: p.dam || null,
                     pen: p.pen,
                     healthStatus: p.health_status,
                     weight: p.weight ? parseFloat(p.weight) : null,
                     dateOfBirth: new Date(p.date_of_birth),
                     notes: p.notes || null
                 }
             });
             processed++;
        }
        
        broadcastSignal('SYNC_PIGS', `pushed_${processed}_pigs`);

        callback(null, { success: true, message: "Synced pigs", items_processed: processed });
    } catch(err) {
        console.error("Error pushing pigs:", err);
        callback(null, { success: false, message: "Sync error", items_processed: 0 });
    }
};

const pushPigScans = async (call: any, callback: any) => {
    const scans = call.request.scans;
    const token = getAuthToken(call);

    try {
        const decoded = verifyToken(token);
        const staffId = decoded.adminId;
        
        console.log(`Processing ${scans?.length} pig scans from staff ID: ${staffId}`);

        let processed = 0;

        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            for (const scan of scans) {
                const pig = await tx.pig.findUnique({
                    where: { rfidTag: scan.rfid_tag }
                });
                
                if (pig) {
                    const timestamp = Number(scan.timestamp);
                    const scanDate = isNaN(timestamp) ? new Date(scan.timestamp) : new Date(timestamp);
                    const safeDate = isNaN(scanDate.getTime()) ? new Date() : scanDate;

                    await tx.pigScan.create({
                        data: {
                            pigId: pig.pigId,
                            timestamp: safeDate,
                            location: scan.location,
                            scannedBy: staffId,
                            notes: scan.notes
                        }
                    });
                    
                    await tx.pig.update({
                        where: { pigId: pig.pigId },
                        data: { lastScanned: safeDate }
                    });
                    processed++;
                }
            }
        });

        callback(null, { success: true, message: "Pig scans saved successfully", items_processed: processed });

    } catch (err) {
        console.error("Auth/Db failed for pushPigScans:", err);
        callback(null, { success: false, message: "Failed to process pig scans", items_processed: 0 });
    }
};

const listenForSignals = (call: any) => {
    const { node_id } = call.request;
    console.log(`Node ${node_id} connected to signal stream`);

    activeStreams.set(node_id, call);

    call.write({
        command: "CONNECTED",
        payload: "Connected to SwineSense Backend"
    });
    
    const interval = setInterval(() => {
        call.write({ command: "HEARTBEAT", payload: new Date().toISOString() });
    }, 30000);

    call.on('cancelled', () => {
        console.log(`Node ${node_id} disconnected`);
        activeStreams.delete(node_id);
        clearInterval(interval);
    });
};

export const startGrpcServer = (port: string) => {
    const server = new grpc.Server();

    server.addService(lensProto.LensSyncService.service, {
      Login: login,
      PushLogs: pushLogs,
      PullUsers: pullUsers,
      PushUsers: pushUsers,
      PullPigs: pullPigs,
      PushPigs: pushPigs,
      PushPigScans: pushPigScans,
      ListenForSignals: listenForSignals,
    });

    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, portVal) => {
      if (err) {
        console.error(err);
        return;
      }
      server.start();
      console.log(`SwineSense Backend (gRPC) running on port ${portVal}`);
    });
};
