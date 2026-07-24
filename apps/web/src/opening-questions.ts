export const OPENING_QUESTION_POOL = [
  "你最近一次改变看法，是因为什么？",
  "如果只能保留一种感官，你会选什么？",
  "描述一件你明知没必要却仍会做的事。",
  "最近有什么小事，让你突然觉得今天还不错？",
  "如果明天不用工作或上课，你今晚最想做什么？",
  "你有没有一个很难向别人解释的习惯？",
  "哪一种声音最容易让你想起某段过去？",
  "如果能删除一种尴尬场面，你会选哪一次？",
  "你最近学会的、最没用但很有趣的知识是什么？",
  "如果生活是一款游戏，你现在最想跳过哪个任务？",
] as const;

export function pickOpeningQuestions(
  count = 3,
  random: () => number = Math.random,
): string[] {
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    count > OPENING_QUESTION_POOL.length
  ) {
    throw new RangeError(
      `开场问题数量必须是 0–${OPENING_QUESTION_POOL.length} 的整数。`,
    );
  }

  const candidates = [...OPENING_QUESTION_POOL];
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const randomValue = random();
    if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
      throw new RangeError("随机数生成器必须返回 [0, 1) 范围内的有限数字。");
    }
    const target = Math.floor(randomValue * (index + 1));
    [candidates[index], candidates[target]] = [
      candidates[target],
      candidates[index],
    ];
  }

  return candidates.slice(0, count);
}
