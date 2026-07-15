const fs = require('node:fs');
const path = require('node:path');

const inputPath = path.join(__dirname, 'data.json');
const outputPath = path.join(__dirname, 'score.json');

// Set a benchmark multiplier here. Benchmarks omitted from this object use 1.
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

function getWeight(benchmarkName) {
  const weight = DIMENSION_WEIGHTS[benchmarkName] ?? 1;

  if (!Number.isFinite(weight) || weight < 0) {
    throw new Error(
      `Invalid multiplier for "${benchmarkName}": ${weight}. Use a finite number greater than or equal to 0.`,
    );
  }

  return weight;
}

function calculateScores(data) {
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

  for (const benchmark of data.benchmarks) {
    const entries = Object.entries(benchmark.scores);
    const rawValues = entries.map(([, value]) => value);
    const min = Math.min(...rawValues);
    const max = Math.max(...rawValues);
    const weight = getWeight(benchmark.name);

    for (const [scoreKey, rawScore] of entries) {
      const modelName = getCanonicalModelName(scoreKey);
      const model = scoresByModel.get(modelName);

      if (!model || weight === 0) {
        continue;
      }

      const normalizedScore = normalize(rawScore, min, max);
      model.dimensions.push({
        name: benchmark.name,
        rawScore,
        normalizedScore,
        weight,
      });
      model.weightedScore += normalizedScore * weight;
      model.totalWeight += weight;
    }
  }

  return [...scoresByModel.values()]
    .map(({ weightedScore, totalWeight, ...model }) => ({
      ...model,
      // Only dimensions with a reported score contribute to this model's denominator.
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
const models = calculateScores(data);

const result = {
  weights: Object.fromEntries(
    data.benchmarks.map(({ name }) => [name, getWeight(name)]),
  ),
  models,
};

fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Wrote ${models.length} model scores to ${outputPath}`);
