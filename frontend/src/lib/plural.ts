// Counting people in sentences. Found on the 10 November 2026 walkthrough
// ("Called off automatically if fewer than 1 people are in", "Confirm once 1
// people say yes") and fixed for 1.0. A threshold of 1 reads best as
// "nobody", not "fewer than 1".

export function people(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

export function peopleSay(n: number): string {
  return n === 1 ? '1 person says' : `${n} people say`;
}

export function peopleCan(n: number): string {
  return n === 1 ? '1 person can' : `${n} people can`;
}

export function autoCancelLine(n: number): string {
  return n === 1
    ? 'Called off automatically if nobody is in.'
    : `Called off automatically if fewer than ${n} people are in.`;
}

export function calledOffLine(threshold: number | null): string {
  if (threshold == null) return 'Too few people were still in, so this day was called off.';
  return threshold === 1
    ? 'Nobody was still in, so this day was called off.'
    : `Fewer than ${threshold} people were still in, so this day was called off.`;
}

export function unlessLeavesFewer(n: number): string {
  return n === 1 ? 'if that leaves nobody in' : `if that leaves fewer than ${n} in`;
}
