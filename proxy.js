// TCP proxy: forwards 0.0.0.0:3002 → 127.0.0.1:3000
// This lets Docker containers reach goosed which only binds loopback
const net = require('net');
const server = net.createServer((client) => {
  const target = net.connect(3000, '127.0.0.1', () => {
    client.pipe(target);
    target.pipe(client);
  });
  target.on('error', () => client.destroy());
  client.on('error', () => target.destroy());
});
server.listen(3002, '0.0.0.0', () => {
  console.log('TCP proxy: 0.0.0.0:3002 → 127.0.0.1:3000');
});
