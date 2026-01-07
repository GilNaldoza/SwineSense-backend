import dotenv from 'dotenv';
dotenv.config();

import { startGrpcServer } from './grpc';
import { startRestServer } from './rest';

const GRPC_PORT = process.env.GRPC_PORT || '50051';
const REST_PORT = process.env.PORT || '3000';

console.log("Starting LENS Backend V2...");

try {
    startGrpcServer(GRPC_PORT);
    startRestServer(REST_PORT);
} catch (err) {
    console.error("Failed to start server:", err);
}
