/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    CELL_URL: process.env.CELL_URL ?? 'http://localhost:3456',
  },
};

export default nextConfig;
