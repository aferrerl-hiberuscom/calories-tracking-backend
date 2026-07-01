/**
 * Dev utility: create a user (or set the password of an existing one).
 *
 * Usage: npx ts-node scripts/create-user.ts <email> <password>
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { hashPassword } from "../src/lib/password";

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error("Usage: npx ts-node scripts/create-user.ts <email> <password>");
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash },
    create: { email, passwordHash },
    select: { id: true, email: true, createdAt: true },
  });

  console.log(`User ready: ${user.email} (id: ${user.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
