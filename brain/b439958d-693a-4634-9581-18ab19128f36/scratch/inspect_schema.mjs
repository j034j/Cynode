import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
try {
    const userColumns = await prisma.$queryRawUnsafe('PRAGMA table_info(User)');
    console.log('User columns:', userColumns);
    const sessionColumns = await prisma.$queryRawUnsafe('PRAGMA table_info(Session)');
    console.log('Session columns:', sessionColumns);
    const shareColumns = await prisma.$queryRawUnsafe('PRAGMA table_info(Share)');
    console.log('Share columns:', shareColumns);
} catch (e) {
    console.error('Database inspection failed:', e);
} finally {
    await prisma.$disconnect();
}
