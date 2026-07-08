process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;

async function setupDB() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('pcp-affiliates-test'));
}

async function teardownDB() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

async function clearDB() {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) await collections[key].deleteMany({});
}

module.exports = { setupDB, teardownDB, clearDB };
