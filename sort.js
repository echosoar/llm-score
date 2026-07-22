const fs = require('node:fs');
const path = require('node:path');

const inputPath = path.join(__dirname, 'data.json');

const outputPath = path.join(__dirname, 'score.json');
const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const scorePi = 10;

// strip from
data.benchmarks.forEach(benchmark => {
  const newScores = {};
  Object.keys(benchmark.scores).forEach(modelName => {
    const newModelName = modelName.replace(/\(.*\)/, '').trim();
    newScores[newModelName] = benchmark.scores[modelName];
  });
  benchmark.scores = newScores;
});

data.models.forEach(model => {
    const currentBenchmarksScores = {};
    data.benchmarks.forEach(benchmark => {
        const aScore = benchmark.scores[model.model];
        if (aScore !== undefined) {
            currentBenchmarksScores[benchmark.name] = aScore;
        }
    });
    model.currentBenchmarksScores = currentBenchmarksScores;

    const sameRanksModels = {};
    data.models.forEach(otherModel => {
        if (otherModel.model === model.model) {
            return;
        }
        let aWinScore = 0;
        let aWinCount = 0;
        let bWinScore = 0;
        let bWinCount = 0;
        data.benchmarks.forEach(benchmark => {
            const aScore = benchmark.scores[model.model];
            const bScore = benchmark.scores[otherModel.model];
            if (aScore === undefined || bScore === undefined) return;
            const midScore = (aScore + bScore) / 2;
            if (aScore > bScore) {
                aWinScore += (aScore - bScore) / midScore;
                aWinCount += 1;
            } else if (bScore > aScore) {
                bWinScore += (bScore - aScore) / midScore;
                bWinCount += 1;
            }
        });
        let  aWin = aWinCount ? aWinScore / aWinCount : 0;
        let  bWin = bWinCount ? bWinScore / bWinCount : 0;
        if (aWinCount != bWinCount) {
            sameRanksModels[otherModel.model] = aWinCount - bWinCount;
        } else if (aWin != bWin) {
            sameRanksModels[otherModel.model] = aWin - bWin;
        }
    });
    const rankModels = Object.keys(sameRanksModels);
    if (model.model === 'MiMo V2.5') {
        console.log('sameRanksModels', sameRanksModels)
    }
    model.betterThanCurrentModels = rankModels.filter(m => sameRanksModels[m] < 0);
});


// sort：拓扑排序，以直接胜负关系建图，从弱到强；无法判定的用被战胜次数兜底
const modelNames = data.models.map(model => model.model);
const nameToModel = new Map(data.models.map(model => [model.model, model]));
const outEdges = new Map(modelNames.map(name => [name, new Set()])); // name 战胜的模型
const beatersCount = new Map(modelNames.map(name => [name, 0])); // 战胜 name 的模型数

data.models.forEach(model => {
    model.betterThanCurrentModels.forEach(beater => {
        outEdges.get(beater).add(model.model);
        beatersCount.set(model.model, beatersCount.get(model.model) + 1);
    });
});

const placed = new Set();
const sortedNames = [];
const remainingOutCount = name =>
    [...outEdges.get(name)].filter(target => !placed.has(target)).length;

while (placed.size < modelNames.length) {
    const unplaced = modelNames.filter(name => !placed.has(name));
    // 出边全部指向已放置节点（只比更弱的模型强）的为候选者，被越多模型战胜则越弱，越先放置
    let candidates = unplaced.filter(name => remainingOutCount(name) === 0);
    if (!candidates.length) {
        // 胜负关系存在环，用剩余出边最少的节点打破
        const minOut = Math.min(...unplaced.map(remainingOutCount));
        candidates = unplaced.filter(name => remainingOutCount(name) === minOut);
    }
    candidates.sort((a, b) =>
        beatersCount.get(b) - beatersCount.get(a) || a.localeCompare(b, 'zh-CN'));
    const next = candidates[0];
    placed.add(next);
    sortedNames.push(next);
}

data.models = sortedNames.map(name => nameToModel.get(name));

const sortedModels = [];

data.models.forEach((cur, index) => {
    if (index === 0) {
        cur.rank = scorePi;
        sortedModels.push({
            modelInfo: cur,
            rank: cur.rank
        });
        return;
    }

    const prev = data.models[index - 1];

    let curWinScore = 0;
    let curWinCount = 0;

    data.benchmarks.forEach(benchmark => {
        let curScore = benchmark.scores[cur.model];
        let prevScore = benchmark.scores[prev.model];
        if (curScore === undefined || prevScore === undefined) return;
        if (curScore > prevScore) {
            curWinScore += (curScore - prevScore) / prevScore;
            curWinCount += 1;
        }
    });

    if (curWinCount === 0) {
        cur.rank = prev.rank;
    } else {
        cur.rank = prev.rank + (curWinScore / curWinCount) * scorePi;
    }
    sortedModels.push({
        modelInfo: cur,
        rank: cur.rank
    });
});

fs.writeFileSync(outputPath, JSON.stringify({
    benchmarks: data.benchmarks,
    models: sortedModels,
    priceMap: data.priceMap
}, null, 2));
