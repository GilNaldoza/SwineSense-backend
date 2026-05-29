import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import authRoutes from './api/auth';
import pigRoutes from './api/pigs';
import adminRoutes from './api/admins';
import auditRoutes from './api/audit';
import analyticsRoutes from './api/analytics';
import treatmentRoutes from './api/treatments';

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
    app.use('/api/pigs', pigRoutes);
    app.use('/api/admins', adminRoutes);
    app.use('/api/audit', auditRoutes);
    app.use('/api/analytics', analyticsRoutes);
    app.use('/api/treatments', treatmentRoutes);

    // Health check
    app.get('/health', (req, res) => {
        res.json({ status: 'ok', timestamp: new Date() });
    });

    app.listen(port, () => {
        console.log(`SwineSense Backend (REST) running on port ${port}`);
    });
};
