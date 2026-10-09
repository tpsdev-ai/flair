export const atomicSignalWriterSource = String.raw`
function publishSignal(target, value) {
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, value);
  fs.renameSync(temporary, target);
}
`;
