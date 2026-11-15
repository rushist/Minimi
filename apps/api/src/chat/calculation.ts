const amount = '(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?';
const deposit = new RegExp(
  '^if i deposit \\$' +
    amount +
    ' at a fixed (\\d+(?:\\.\\d+)?)% apy for one year with no fees or withdrawals,? what is my ending balance\\??$',
  'i',
);
const recipe =
  /^scale (?:a|the) recipe (?:that uses|with) (\d+(?:\.\d+)?) g flour and (\d+(?:\.\d+)?) g water from (\d+) servings? to (\d+) servings?[.?!]?$/i;
const statistics =
  /^(?:explain the difference between mean and median using the numbers|calculate the mean and median of) ([+-]?\d+(?:\.\d+)?(?:,\s*[+-]?\d+(?:\.\d+)?){1,99})[.?!]?$/i;
const format = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

export function calculateLocally(message: string): string | undefined {
  const input = message.trim();
  const savings = deposit.exec(input);
  if (savings) {
    const principal = Number(
      savings[1]!.replaceAll(',', '') + '.' + (savings[2] ?? '0'),
    );
    const rate = Number(savings[3]);
    const ending = principal * (1 + rate / 100);
    if (Number.isFinite(ending) && ending <= 1e12)
      return `Your ending balance is **${currency.format(ending)}** after one year. ${currency.format(principal)} × (1 + ${format.format(rate)}%) = ${currency.format(ending)}.`;
  }

  const scaling = recipe.exec(input);
  if (scaling) {
    const [flour, water, from, to] = scaling.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const ratio = to / from;
    if (
      from > 0 &&
      to > 0 &&
      [flour, water, from, to, flour * ratio, water * ratio].every(
        (value) => Number.isFinite(value) && value <= 1e12,
      )
    )
      return `For ${format.format(to)} servings, use **${format.format(flour * ratio)} g flour** and **${format.format(water * ratio)} g water**. Multiply each amount by ${format.format(to)}/${format.format(from)}.`;
  }

  const sample = statistics.exec(input);
  if (sample) {
    const numbers = sample[1]!
      .split(',')
      .map(Number)
      .sort((left, right) => left - right);
    if (
      !numbers.every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 1e12,
      )
    )
      return;
    const sum = numbers.reduce((total, value) => total + value, 0);
    const middle = Math.floor(numbers.length / 2);
    const median =
      numbers.length % 2
        ? numbers[middle]!
        : (numbers[middle - 1]! + numbers[middle]!) / 2;
    return `The **mean is ${format.format(sum / numbers.length)}**, the sum (${format.format(sum)}) divided by ${numbers.length}. The **median is ${format.format(median)}**, the middle of the sorted values${numbers.length % 2 ? '' : ' found by averaging the two central values'}.`;
  }
}
