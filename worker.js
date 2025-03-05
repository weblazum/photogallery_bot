require('dotenv').config();
const Queue = require('bull');
const FormData = require('form-data');
const fs = require('fs');
const axios = require('axios');
const path = require('path');

// Конфигурация из .env
const WP_URL = process.env.WP_URL;
const WP_USER = process.env.WP_USER;
const WP_PASSWORD = process.env.WP_PASSWORD;

// Подключаем redis + bull
const photoQueue = new Queue('photoQueue', { 
	redis: { host: '127.0.0.1', port: 6379 }, 
	limiter: { max: 10, duration: 1000 }, 
});

// Функция логирования
function logToFile(message) {
	const logFilePath = path.join(__dirname, 'bot_logs.txt');
	const timestamp = new Date().toISOString();
	const logMessage = `[${timestamp}] ${message}\n`;
	fs.appendFileSync(logFilePath, logMessage);
}

// Функция загрузки
async function uploadToWordPress(filePath) {
	const form = new FormData();
	form.append('file', fs.createReadStream(filePath));
	
	const auth = Buffer.from(`${WP_USER}:${WP_PASSWORD}`).toString('base64');
	try {
		const response = await axios.post(`${WP_URL}/media`, form, {
			headers: { ...form.getHeaders(), Authorization: `Basic ${auth}` },
		});
		return response.data;
	} catch (error) {
		logToFile('Ошибка загрузки в WordPress:' + error.response?.data || error);
		console.error('Ошибка загрузки в WordPress:', error.response?.data || error);
		return null;
	}
}

// Функция создания поста
async function createPost(title, imageId) {
	const auth = Buffer.from(`${WP_USER}:${WP_PASSWORD}`).toString('base64');
	try {
		const response = await axios.post(`${WP_URL}/posts`, {
			title: title,
			status: 'publish',
			featured_media: imageId,
		}, {
			headers: { Authorization: `Basic ${auth}` },
		});
		return response.data.link;
	} catch (error) {
		logToFile('Ошибка создания поста:' + error.response?.data || error);
		console.error('Ошибка создания поста:', error.response?.data || error);
		return null;
	}
}

// Обработчик очереди
photoQueue.process(async (job) => {
	try {
		const { fullName, photoPath, userId } = job.data;

		logToFile(`Обрабатываем фото для ${fullName}`);
		console.log(`Обрабатываем фото для ${fullName}`);

		// Загрузка в wordpress
		const imageData = await uploadToWordPress(photoPath);

		if (!imageData || !imageData.id) {
			logToFile(`Ошибка загрузки изображения для ${fullName}`);
			console.error('Ошибка загрузки изображения');
			return;
		}

		// Создание поста в wordpress
		const postLink = await createPost(fullName, imageData.id);

		if (fs.existsSync(photoPath)) {
			fs.unlinkSync(photoPath);
		}
		
		logToFile(`Пост создан: ${postLink}`);
		console.log(`Пост создан: ${postLink}`);
	} catch (error) {
		logToFile(`Ошибка в задаче: ` + error);
		console.error('Ошибка в задаче:', error);
	}
});	

console.log('Воркер запущен!');