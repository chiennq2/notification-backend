// encodeServiceAccount.js
// Đặt file này ở thư mục gốc backend
// Chạy: node encodeServiceAccount.js

const fs = require('fs');

console.log('🔄 Đang encode serviceAccountKey.json...\n');

try {
  // Đọc file
  const fileContent = fs.readFileSync('./serviceAccountKey.json', 'utf8');
  
  // Kiểm tra file có hợp lệ không
  JSON.parse(fileContent); // Sẽ throw error nếu không phải JSON hợp lệ
  
  // Convert sang base64
  const base64 = Buffer.from(fileContent).toString('base64');
  
  console.log('✅ Encode thành công!\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('📋 Copy đoạn này vào file .env:\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`FIREBASE_SERVICE_ACCOUNT_BASE64=${base64}\n`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  // Tự động tạo file .env nếu chưa có
  if (!fs.existsSync('.env')) {
    const envContent = `# Server Configuration
PORT=3001

# Firebase Admin SDK (Base64 encoded serviceAccountKey.json)
FIREBASE_SERVICE_ACCOUNT_BASE64=${base64}
`;
    fs.writeFileSync('.env', envContent);
    console.log('✅ Đã tự động tạo file .env!\n');
  } else {
    console.log('⚠️  File .env đã tồn tại. Vui lòng copy thủ công.\n');
  }
  
  // Tạo .env.example
  const envExample = `# Server Configuration
PORT=3001

# Firebase Admin SDK (Base64 encoded serviceAccountKey.json)
FIREBASE_SERVICE_ACCOUNT_BASE64=paste_your_base64_string_here
`;
  fs.writeFileSync('.env.example', envExample);
  console.log('✅ Đã tạo file .env.example\n');
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚠️  BẢO MẬT:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('1. KHÔNG commit file serviceAccountKey.json lên Git');
  console.log('2. KHÔNG commit file .env lên Git');
  console.log('3. Chỉ commit file .env.example');
  console.log('4. Thêm vào .gitignore:\n');
  console.log('   serviceAccountKey.json');
  console.log('   .env\n');
  
} catch (error) {
  console.error('❌ Lỗi:', error.message);
  console.log('\n💡 Kiểm tra:');
  console.log('1. File serviceAccountKey.json có tồn tại không?');
  console.log('2. File có đúng format JSON không?');
  console.log('3. Đã đặt file ở đúng thư mục chưa?\n');
}