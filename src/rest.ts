import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import authRoutes from './api/auth';
import userRoutes from './api/users';
import pigRoutes from './api/pigs';
import logRoutes from './api/logs';
import adminRoutes from './api/admins';
import auditRoutes from './api/audit';
import analyticsRoutes from './api/analytics';

export const startRestServer = (port: string) => {
    const app = express();

    const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173,http://localhost:5174,http://localhost:5000')
        .split(',').map(s => s.trim()).filter(Boolean);
    app.use(cors({
        origin: corsOrigins,
        credentials: true
    }));
    app.use(express.json());
    app.use(morgan('dev'));

    // Routes
    app.use('/api/auth', authRoutes);
    app.use('/api/users', userRoutes);
    app.use('/api/pigs', pigRoutes);
    app.use('/api/logs', logRoutes);
    app.use('/api/admins', adminRoutes);
    app.use('/api/audit', auditRoutes);
    app.use('/api/analytics', analyticsRoutes);

    // Health check
    app.get('/health', (req, res) => {
        res.json({ status: 'ok', timestamp: new Date() });
    });

    app.listen(port, () => {
        console.log(`SwineSense Backend (REST) running on port ${port}`);
    });
};
