const http = require('http');
const { app } = require('../../src/app');
const { attachSocketServer } = require('../../src/lib/realtime');

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    const io = attachSocketServer(server);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        io,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((res) => {
            io.close();
            server.close(() => res());
          })
      });
    });
  });
}

module.exports = { startTestServer };
