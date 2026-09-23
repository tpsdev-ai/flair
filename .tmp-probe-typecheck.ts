declare function fC<T>(d: string, fn: () => T): T;
const cSync: string = fC("d", () => "x");
fC("d", async () => "x");
