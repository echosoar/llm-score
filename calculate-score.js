const fs = require('node:fs');
const path = require('node:path');

const inputPath = path.join(__dirname, 'data.json');
const outputPath = path.join(__dirname, 'score.json');
const readmePath = path.join(__dirname, 'readme.md');

// Set an optional benchmark multiplier here. Benchmarks omitted from this object use 1.
// Each benchmark's effective multiplier is this value × sqrt(the number of models reporting it).
// A multiplier of 0 excludes that benchmark from the final score.
const DIMENSION_WEIGHTS = {
  // 'SWE-Bench Pro': 1.5,
};

function getCanonicalModelName(scoreKey) {
  return scoreKey.replace(/\s*\([^)]*\)\s*$/, '');
}

function normalize(value, min, max) {
  return max === min ? 1 : (value - min) / (max - min);
}

function getConfiguredWeight(benchmarkName) {
  const weight = DIMENSION_WEIGHTS[benchmarkName] ?? 1;

  if (!Number.isFinite(weight) || weight < 0) {
    throw new Error(
      `Invalid multiplier for "${benchmarkName}": ${weight}. Use a finite number greater than or equal to 0.`,
    );
  }

  return weight;
}

function getDimensionWeights(benchmarkName, modelCount) {
  const configuredWeight = getConfiguredWeight(benchmarkName);
  const baseWeight = Math.sqrt(modelCount);

  return {
    configuredWeight,
    baseWeight,
    weight: configuredWeight * baseWeight,
  };
}

function createBenchmarkEntries(benchmark) {
  const entriesByModel = new Map();

  return Object.entries(benchmark.scores).map(([scoreKey, rawScore]) => {
    const modelName = getCanonicalModelName(scoreKey);

    if (entriesByModel.has(modelName)) {
      throw new Error(
        `Benchmark "${benchmark.name}" has multiple scores for canonical model name "${modelName}".`,
      );
    }

    const entry = {
      scoreKey,
      modelName,
      rawScore,
      source: 'reported',
    };
    entriesByModel.set(modelName, entry);
    return entry;
  });
}

function averageMultipliers(entries) {
  return entries.reduce((total, entry) => total + entry.multiplier, 0) / entries.length;
}

function findProjectionMultiplier(legacyScore, knownMultipliers, benchmarkName) {
  const matchingScores = knownMultipliers.filter(
    ({ legacyScore: knownScore }) => knownScore === legacyScore,
  );

  if (matchingScores.length > 0) {
    return {
      value: averageMultipliers(matchingScores),
      method: 'matching-score-average',
      neighbors: matchingScores.map(({ modelName }) => modelName),
    };
  }

  const orderedMultipliers = [...knownMultipliers].sort(
    (left, right) => left.legacyScore - right.legacyScore,
  );
  const lower = orderedMultipliers.filter(
    ({ legacyScore: score }) => score < legacyScore,
  ).at(-1);
  const upper = orderedMultipliers.find(({ legacyScore: score }) => score > legacyScore);

  if (lower && upper) {
    return {
      value: averageMultipliers([lower, upper]),
      method: 'adjacent-average',
      neighbors: [lower.modelName, upper.modelName],
    };
  }

  const neighbor = lower ?? upper;
  if (neighbor) {
    // The supplied Terminal-Bench data has only one overlap, so there is no pair
    // of bracketing multipliers to average. Reuse its nearest reported multiplier.
    return {
      value: neighbor.multiplier,
      method: 'nearest-neighbor-fallback',
      neighbors: [neighbor.modelName],
    };
  }

  throw new Error(
    `Cannot project scores from "${benchmarkName}": no overlapping reported scores with its upgraded benchmark.`,
  );
}

function prepareBenchmarks(data) {
  const benchmarksByName = new Map();
  const preparedBenchmarks = data.benchmarks.map((benchmark) => {
    if (benchmarksByName.has(benchmark.name)) {
      throw new Error(`Duplicate benchmark name: "${benchmark.name}".`);
    }

    const preparedBenchmark = {
      name: benchmark.name,
      upgrade: benchmark.upgrade,
      entries: createBenchmarkEntries(benchmark),
      calibrations: [],
      projections: [],
    };
    benchmarksByName.set(benchmark.name, preparedBenchmark);
    return preparedBenchmark;
  });

  for (const legacyBenchmark of preparedBenchmarks.filter(({ upgrade }) => upgrade)) {
    const upgradedBenchmark = benchmarksByName.get(legacyBenchmark.upgrade);

    if (!upgradedBenchmark) {
      throw new Error(
        `Benchmark "${legacyBenchmark.name}" references missing upgrade "${legacyBenchmark.upgrade}".`,
      );
    }
    if (upgradedBenchmark.upgrade) {
      throw new Error(
        `Benchmark "${legacyBenchmark.name}" must point directly to a final benchmark, not legacy benchmark "${upgradedBenchmark.name}".`,
      );
    }

    const reportedUpgradedEntriesByModel = new Map(
      upgradedBenchmark.entries
        .filter(({ source }) => source === 'reported')
        .map((entry) => [entry.modelName, entry]),
    );
    const upgradedEntriesByModel = new Map(
      upgradedBenchmark.entries.map((entry) => [entry.modelName, entry]),
    );
    const overlappingEntries = legacyBenchmark.entries
      .filter((entry) => reportedUpgradedEntriesByModel.has(entry.modelName))
      .map((legacyEntry) => {
        if (legacyEntry.rawScore === 0) {
          throw new Error(
            `Cannot calculate an upgrade multiplier for "${legacyBenchmark.name}" and model "${legacyEntry.modelName}" because its legacy score is 0.`,
          );
        }

        const upgradedEntry = reportedUpgradedEntriesByModel.get(legacyEntry.modelName);
        return {
          modelName: legacyEntry.modelName,
          legacyScore: legacyEntry.rawScore,
          upgradedScore: upgradedEntry.rawScore,
          multiplier: upgradedEntry.rawScore / legacyEntry.rawScore,
        };
      });
    legacyBenchmark.calibrations = overlappingEntries;

    for (const legacyEntry of legacyBenchmark.entries) {
      if (reportedUpgradedEntriesByModel.has(legacyEntry.modelName)) {
        continue;
      }
      if (upgradedEntriesByModel.has(legacyEntry.modelName)) {
        throw new Error(
          `Model "${legacyEntry.modelName}" is projected into "${upgradedBenchmark.name}" by more than one legacy benchmark.`,
        );
      }

      const projection = findProjectionMultiplier(
        legacyEntry.rawScore,
        overlappingEntries,
        legacyBenchmark.name,
      );
      const projectedEntry = {
        scoreKey: legacyEntry.modelName,
        modelName: legacyEntry.modelName,
        rawScore: legacyEntry.rawScore * projection.value,
        source: 'projected',
        projection: {
          fromBenchmark: legacyBenchmark.name,
          legacyScore: legacyEntry.rawScore,
          multiplier: projection.value,
          method: projection.method,
          neighbors: projection.neighbors,
        },
      };

      upgradedBenchmark.entries.push(projectedEntry);
      upgradedEntriesByModel.set(projectedEntry.modelName, projectedEntry);
      upgradedBenchmark.projections.push({
        modelName: projectedEntry.modelName,
        ...projectedEntry.projection,
        projectedScore: projectedEntry.rawScore,
      });
    }
  }

  return preparedBenchmarks;
}

function calculateScores(data, benchmarks) {
  const scoresByModel = new Map(
    data.models.map((model) => [
      model.model,
      {
        ...model,
        dimensions: [],
        weightedScore: 0,
        totalWeight: 0,
      },
    ]),
  );

  for (const benchmark of benchmarks) {
    // A benchmark with `upgrade` is legacy calibration data, not a final-score dimension.
    if (benchmark.upgrade) {
      continue;
    }

    const rawValues = benchmark.entries.map(({ rawScore }) => rawScore);
    const min = Math.min(...rawValues);
    const max = Math.max(...rawValues);
    const { configuredWeight, baseWeight, weight } = getDimensionWeights(
      benchmark.name,
      benchmark.entries.length,
    );

    for (const entry of benchmark.entries) {
      const model = scoresByModel.get(entry.modelName);

      if (!model || weight === 0) {
        continue;
      }

      const normalizedScore = normalize(entry.rawScore, min, max);
      model.dimensions.push({
        name: benchmark.name,
        modelCount: benchmark.entries.length,
        rawScore: entry.rawScore,
        normalizedScore,
        source: entry.source,
        ...(entry.projection ? { projection: entry.projection } : {}),
        configuredWeight,
        baseWeight,
        weight,
      });
      model.weightedScore += normalizedScore * weight;
      model.totalWeight += weight;
    }
  }

  return [...scoresByModel.values()]
    .map(({ weightedScore, totalWeight, ...model }) => ({
      ...model,
      // Only included dimensions with a reported or projected score contribute.
      score: totalWeight === 0 ? null : weightedScore / totalWeight,
      totalWeight,
    }))
    .sort((left, right) => {
      if (left.score === null) return 1;
      if (right.score === null) return -1;
      return right.score - left.score || left.model.localeCompare(right.model);
    })
    .map((model, index) => ({
      rank: model.score === null ? null : index + 1,
      ...model,
    }));
}

const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const benchmarks = prepareBenchmarks(data);
const models = calculateScores(data, benchmarks);

const result = {
  weights: Object.fromEntries(
    benchmarks.map((benchmark) => {
      const included = !benchmark.upgrade;
      return [
        benchmark.name,
        {
          included,
          ...(benchmark.upgrade ? { upgrade: benchmark.upgrade } : {}),
          modelCount: benchmark.entries.length,
          ...(included
            ? getDimensionWeights(benchmark.name, benchmark.entries.length)
            : {}),
          ...(benchmark.calibrations.length
            ? { calibrations: benchmark.calibrations }
            : {}),
          ...(benchmark.projections.length
            ? { projections: benchmark.projections }
            : {}),
        },
      ];
    }),
  ),
  models,
  priceMap: data.priceMap ?? {},
};

fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);

const rankedModels = models.filter((model) => model.rank !== null);
const readmeLines = rankedModels.map(
  (model) => `${model.rank}. ${model.brand} ${model.model} (score: ${model.score.toFixed(4)})`,
);
fs.writeFileSync(readmePath, `${readmeLines.join('\n')}\n`);

console.log(`Wrote ${models.length} model scores to ${outputPath}`);
console.log(`Wrote ${rankedModels.length} ranked models to ${readmePath}`);
