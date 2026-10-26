import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createPrismaMock } from '../helpers/prismaMock';

/**
 * Contract test for the Prisma double.
 *
 * This exists because of a real failure: the double's `busPass` model was
 * hand-listed without `findFirst`, so two tests died with
 * "Cannot read properties of undefined" — the *test double* was wrong, not the
 * application. Hand-maintained mock surfaces drift from the schema silently.
 *
 * These assertions make the drift loud and immediate:
 *
 *  1. every `model` in prisma/schema.prisma exists on the mock;
 *  2. every `prisma.<model>.<method>` (and `tx.<model>.<method>`) actually used
 *     in the route handlers exists on the mock.
 *
 * Adding a model or calling a new delegate method in a route without extending
 * the double now fails here, with a clear message, instead of surfacing as a
 * confusing TypeError deep inside an unrelated test.
 */

const PROJECT_ROOT = process.cwd();
const API_DIR = join(PROJECT_ROOT, 'src', 'app', 'api');
const SCHEMA_PATH = join(PROJECT_ROOT, 'prisma', 'schema.prisma');

/** Recursively collects every `route.js` under the API directory. */
const collectRouteFiles = (dir) => {
  const found = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectRouteFiles(full));
    } else if (entry === 'route.js') {
      found.push(full);
    }
  }

  return found;
};

/** `model User {` -> "User"; the mock uses the lowercased, uncapitalised name. */
const parseSchemaModels = () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const models = [];

  for (const match of schema.matchAll(/^\s*model\s+(\w+)\s*\{/gm)) {
    // Prisma's client exposes `user` for `model User`.
    models.push(match[1].charAt(0).toLowerCase() + match[1].slice(1));
  }

  return models;
};

/**
 * Extracts `<client>.<model>.<method>` usages from source.
 *
 * `$transaction`/`$connect` are naturally excluded because `$` is not matched
 * by `[A-Za-z]`. `tx` is the interactive-transaction client, which the double
 * serves from the same object as `prisma`.
 */
const extractPrismaUsages = (source) => {
  const usages = new Set();

  for (const match of source.matchAll(
    /\b(?:prisma|tx)\.([A-Za-z]\w*)\.([A-Za-z]\w*)\s*\(/g,
  )) {
    usages.add(`${match[1]}.${match[2]}`);
  }

  return usages;
};

const routeFiles = collectRouteFiles(API_DIR);

describe('prisma double covers the schema', () => {
  it('exposes every model declared in prisma/schema.prisma', () => {
    const prisma = createPrismaMock();
    const schemaModels = parseSchemaModels();

    expect(schemaModels.length).toBeGreaterThan(0);

    for (const model of schemaModels) {
      expect(prisma[model], `missing model "${model}" on the mock`).toBeDefined();
    }
  });

  it('gives each model the full delegate surface', () => {
    const prisma = createPrismaMock();

    // Prisma's delegate API is uniform, so every model must expose all of these.
    const required = [
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findFirstOrThrow',
      'findMany',
      'create',
      'createMany',
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
      'count',
      'aggregate',
      'groupBy',
    ];

    for (const model of parseSchemaModels()) {
      for (const method of required) {
        expect(
          typeof prisma[model][method],
          `${model}.${method} is missing from the mock`,
        ).toBe('function');
      }
    }
  });
});

describe('prisma double covers every usage in the route handlers', () => {
  it('finds route files to check', () => {
    // Guards against the collector silently returning nothing, which would make
    // every assertion below vacuously true.
    expect(routeFiles.length).toBeGreaterThan(5);
  });

  it('has a delegate for every prisma.<model>.<method> used in a route', () => {
    const prisma = createPrismaMock();
    const missing = [];

    for (const file of routeFiles) {
      const source = readFileSync(file, 'utf8');

      for (const usage of extractPrismaUsages(source)) {
        const [model, method] = usage.split('.');
        const where = relative(PROJECT_ROOT, file);

        if (!prisma[model]) {
          missing.push(`${where}: unknown model "${model}"`);
          continue;
        }

        if (typeof prisma[model][method] !== 'function') {
          missing.push(`${where}: ${model}.${method} is not a function on the mock`);
        }
      }
    }

    // Reported as a list so a single run reveals every gap at once.
    expect(missing).toEqual([]);
  });

  it('detects usages it is meant to detect (self-check)', () => {
    // Proves the extractor actually works, so the assertion above cannot pass
    // by matching nothing.
    const usages = extractPrismaUsages(
      'await prisma.busPass.findFirst({}); await tx.booking.updateMany({});',
    );

    expect([...usages]).toEqual(
      expect.arrayContaining(['busPass.findFirst', 'booking.updateMany']),
    );
  });

  it('ignores $ prefixed client methods', () => {
    const usages = extractPrismaUsages('await prisma.$transaction(async () => {});');
    expect([...usages]).toEqual([]);
  });
});
