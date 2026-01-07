import prisma from '../src/db';
import bcrypt from 'bcryptjs';

async function main() {
  const password = "admin";
  const hashedPassword = await bcrypt.hash(password, 10);

  const admin = await prisma.admin.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      passwordHash: hashedPassword,
      fullName: 'System Administrator',
      email: 'admin@lens.local',
      role: 'super_admin'
    },
  });

  console.log({ admin });
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
