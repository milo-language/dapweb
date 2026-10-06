// A port nothing is listening on, from the kernel rather than a guess: suites
// used to pick 8700 + pid % N and collided with dev servers and with leftovers
// from killed runs. The port is released before the server binds it; losing
// that race fails loudly on bind, it never tests the wrong server.
import { createServer } from "node:net";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}
