-- CreateTable
CREATE TABLE "users" (
    "user_id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "id_number" TEXT NOT NULL,
    "rfid_tag" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT,
    "user_type" TEXT NOT NULL,
    "college" TEXT,
    "department" TEXT,
    "year_level" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "admins" (
    "admin_id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'staff',
    "last_login" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "audit_id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "admin_id" INTEGER NOT NULL,
    "action_type" TEXT NOT NULL,
    "target_table" TEXT NOT NULL,
    "target_id" TEXT,
    "description" TEXT,
    "ip_address" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins" ("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "entry_logs" (
    "log_id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER,
    "rfid_tag" TEXT,
    "entry_timestamp" DATETIME NOT NULL,
    "entry_method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'success',
    "node_id" TEXT,
    "location" TEXT,
    "staff_id" INTEGER,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "entry_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "entry_logs_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "admins" ("admin_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "pigs" (
    "pig_id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "rfid_tag" TEXT NOT NULL,
    "pig_number" TEXT NOT NULL,
    "pig_type" TEXT NOT NULL,
    "sire" TEXT,
    "dam" TEXT,
    "pen" TEXT NOT NULL,
    "health_status" TEXT NOT NULL DEFAULT 'healthy',
    "weight" REAL,
    "date_of_birth" DATETIME NOT NULL,
    "notes" TEXT,
    "last_scanned" DATETIME,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "pig_scans" (
    "scan_id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pig_id" INTEGER NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "location" TEXT,
    "scanned_by" INTEGER,
    "notes" TEXT,
    CONSTRAINT "pig_scans_pig_id_fkey" FOREIGN KEY ("pig_id") REFERENCES "pigs" ("pig_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "pig_scans_scanned_by_fkey" FOREIGN KEY ("scanned_by") REFERENCES "admins" ("admin_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_id_number_key" ON "users"("id_number");

-- CreateIndex
CREATE UNIQUE INDEX "users_rfid_tag_key" ON "users"("rfid_tag");

-- CreateIndex
CREATE UNIQUE INDEX "admins_username_key" ON "admins"("username");

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "pigs_rfid_tag_key" ON "pigs"("rfid_tag");

-- CreateIndex
CREATE UNIQUE INDEX "pigs_pig_number_key" ON "pigs"("pig_number");
