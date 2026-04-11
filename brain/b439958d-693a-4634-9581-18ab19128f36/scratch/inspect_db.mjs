import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
try {
    const user = await prisma.user.findFirst();
    console.log('User found:', !!user);
    if (user) console.log('User fields:', Object.keys(user));
    const session = await prisma.session.findFirst();
    console.log('Session found:', !!session);
    if (session) console.log('Session fields:', Object.keys(session));
} catch (e) {
    console.error('Database inspection failed:', e);
} finally {
    await prisma.$disconnect();
}
