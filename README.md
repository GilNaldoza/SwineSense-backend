# LENS Backend V2

The central server for the Library Entry Management System (LENS). This backend handles data persistence, authentication, API requests from the frontend dashboard, and gRPC synchronization with LENS Reader nodes.

## 🏗 Architecture

- **Framework**: Express.js (Node.js) with TypeScript
- **Database**: PostgreSQL (via Prisma ORM)
- **API Styles**:
  - **REST**: For the Admin Dashboard (Frontend)
  - **gRPC**: For efficient, bi-directional syncing with Reader Nodes
- **Authentication**: JWT-based auth for admins & nodes

## ✨ Features

- **Advanced Filtering**: Filter entry logs by Location, College, Department, Date Range, User Type, and Year Level.
- **Analytics API**: Endpoints for generating library usage statistics and charts.
- **Location Tracking**: Supports granular location tagging (e.g., "Main Library", "Graduate Library") for entry logs.
- **Archive & Restore**: Soft-delete entries with the ability to view and restore archived logs.
- **Role-Based Access**: Granular permissions for Super Admins and Staff.
- **Audit Logging**: Tracks all administrative actions for security and accountability.
- **Export**: Generate CSV exports of logs with detailed metadata (Location, Staff, Node ID).

## 🚀 Getting Started

### Prerequisites

- Node.js (v18+)
- PostgreSQL Database
- Docker (optional, for DB setup)

### Environment Variables

Create a `.env` file in the root directory:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/lens_db?schema=public"
PORT=3000
GRPC_PORT=50051
JWT_SECRET="your-secret-key"
NODE_ENV="development"
```

### Installation

1.  **Install dependencies:**
    ```bash
    npm install
    ```

2.  **Setup Database:**
    ```bash
    # Run migrations
    npx prisma migrate dev
    
    # (Optional) Seed data
    npx prisma db seed
    ```

3.  **Run Development Server:**
    ```bash
    npm run dev
    ```
    This starts both the REST server (port 3000) and gRPC server (port 50051).

## 📚 API Overview

### Logs
- `GET /api/logs`: Fetch entry logs with query params (`?location=...&college=...`).
- `GET /api/logs/export`: Download CSV of logs.

### Analytics
- `GET /api/analytics/summary`: General stats.
- `GET /api/analytics/peak-hours`: Peak usage times.

### Syncing
The gRPC service is defined in `src/proto/lens.proto` and handles:
- `SyncUser`: Pushing/Pulling user data.
- `SyncLog`: Uploading entry logs from nodes.
- `StreamSignals`: Real-time backend-to-node commands.
