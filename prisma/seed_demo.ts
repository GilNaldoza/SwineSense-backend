import prisma from '../src/db';
import bcrypt from 'bcryptjs';

async function main() {
  // Create demo super admin (idempotent via upsert)
  const adminPass = 'admin';
  const hashed = await bcrypt.hash(adminPass, 10);
  await prisma.admin.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      passwordHash: hashed,
      fullName: 'System Administrator',
      email: 'admin@lens.local',
      role: 'super_admin'
    }
  });

  // Create demo pigs
  const pigs = [
    { rfidTag: 'PIG_SIM_001', pigNumber: '1001', pigType: 'piglet', pen: 'DemoPen', dateOfBirth: new Date('2024-01-01') },
    { rfidTag: 'PIG_SIM_002', pigNumber: '1002', pigType: 'sow', pen: 'DemoPen', dateOfBirth: new Date('2022-06-15') },
  ];

  for (const p of pigs) {
    await prisma.pig.upsert({
      where: { rfidTag: p.rfidTag },
      update: {},
      create: {
        rfidTag: p.rfidTag,
        pigNumber: p.pigNumber,
        pigType: p.pigType as any,
        pen: p.pen,
        dateOfBirth: p.dateOfBirth,
      }
    });
  }

  console.log('Demo seed complete. Super-admin: admin/admin; demo pigs created.');
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
