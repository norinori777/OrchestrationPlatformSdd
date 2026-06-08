import { PrismaClient } from '@prisma/client';
import { validateOrchestrationDefinition } from '../orchestrations/validateOrchestration.ts';

async function main() {
  const prisma = new PrismaClient();
  const rows = await prisma.orchestrationDefinition.findMany({ select: { id: true, definition: true } });
  let hasError = false;
  for (const r of rows) {
    const res = validateOrchestrationDefinition(r.definition as unknown);
    if (!res.valid) {
      hasError = true;
      console.error(`Invalid orchestration ${r.id}:`, res.errors);
    }
  }
  await prisma.$disconnect();
  if (hasError) process.exitCode = 2;
  else console.log('All orchestration definitions are valid');
}

main().catch((err) => { console.error(err); process.exit(1); });
