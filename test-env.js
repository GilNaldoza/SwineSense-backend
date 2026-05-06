require('dotenv').config();

console.log('JWT_SECRET:', process.env.JWT_SECRET ? '✓ SET' : '✗ MISSING');
console.log('PORT:', process.env.PORT || '3000');
console.log('GRPC_PORT:', process.env.GRPC_PORT || '50060');
console.log('\nAll environment variables loaded successfully!');
