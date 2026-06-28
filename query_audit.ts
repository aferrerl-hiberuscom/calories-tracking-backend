import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    const logs = await prisma.auditLog.findMany({
      where: {
        endpoint: {
          contains: 'nutrition'
        }
      },
      orderBy: {
        timestamp: 'desc'
      },
      take: 5
    });

    console.log('======= AUDIT LOGS =======');
    console.log(`Found ${logs.length} log entries\n`);
    
    logs.forEach((log, i) => {
      console.log(`Log ${i+1}:`);
      console.log(`  User ID: ${log.userId}`);
      console.log(`  Endpoint: ${log.endpoint}`);
      console.log(`  Timestamp: ${log.timestamp}`);
      console.log(`  Status: ${log.status}`);
      console.log(`  Latency (ms): ${log.latencyMs}`);
      console.log(`  Error Message: ${log.errorMessage || 'N/A'}`);
      console.log('');
    });

  } catch (e) {
    console.error('Error connecting to database:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
