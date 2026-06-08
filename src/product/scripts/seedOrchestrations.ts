import { PrismaClient } from '@prisma/client';
import { ORCHESTRATION_CATALOG } from '../orchestrations/catalog.ts';
import { validateOrchestrationDefinition } from '../orchestrations/validateOrchestration.ts';

async function main() {
  const prisma = new PrismaClient();

  for (const [id, def] of Object.entries(ORCHESTRATION_CATALOG)) {
    console.log(`Upserting orchestration: ${id}`);
    const res = validateOrchestrationDefinition(def);
    if (!res.valid) {
      console.error(`Orchestration ${id} is invalid:`, res.errors);
      throw new Error(`Invalid orchestration definition for ${id}: ${res.errors.join('; ')}`);
    }
    await prisma.orchestrationDefinition.upsert({
      where: { id },
      update: {
        definition: def as unknown as object,
        title: id,
        enabled: true,
        updatedAt: new Date(),
      },
      create: {
        id,
        title: id,
        description: '',
        definition: def as unknown as object,
        enabled: true,
      },
    });
  }

  await prisma.$disconnect();
  console.log('Orchestration seed completed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
