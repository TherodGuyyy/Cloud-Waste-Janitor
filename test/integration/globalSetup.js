/**
 * Runs once before the integration tests.
 * Fails early, with a plain explanation, if the fake AWS server is not available.
 */
module.exports = async function globalSetup() {
  const endpoint = process.env.MOTO_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      'MOTO_ENDPOINT is not set. Start the fake AWS with "moto_server -p 5555" and run: ' +
        'MOTO_ENDPOINT=http://127.0.0.1:5555 npm run test:integration',
    );
  }
  try {
    const response = await fetch(`${endpoint}/moto-api/`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      throw new Error(`answered with HTTP ${response.status}`);
    }
  } catch (error) {
    throw new Error(`Cannot reach the fake AWS server at ${endpoint}: ${error.message}`);
  }
};
