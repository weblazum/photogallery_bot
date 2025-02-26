require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const Queue = require('bull'); 
const Redis = require('ioredis');

// Подключение к Redis
const redisClient = new Redis();
const uploadQueue = new Queue('uploadQueue', { redis: { host: '127.0.0.1', port: 6379 } });

// Конфигурация из .env
const bot = new Telegraf(process.env.BOT_API_KEY);
bot.use(session());
const WP_URL = process.env.WP_URL;
const WP_USER = process.env.WP_USER;
const WP_PASSWORD = process.env.WP_PASSWORD;

// Функция загрузки изображения в WordPress
async function uploadToWordPress(filePath) {
	const form = new FormData();
	form.append('file', fs.createReadStream(filePath));

	const auth = Buffer.from(`${WP_USER}:${WP_PASSWORD}`).toString('base64');

	try {
		const response = await axios.post(`${WP_URL}/media`, form, {
			headers: {
				...form.getHeaders(),
				Authorization: `Basic ${auth}`
			}
		});
		return response.data;
	} catch (error) {
		console.error('Ошибка загрузки в WordPress:', error.response?.data || error);
		return null;
	}
}

// Функция создания поста в WordPress с изображением
async function createPost(title, imageId) {
	const auth = Buffer.from(`${WP_USER}:${WP_PASSWORD}`).toString('base64');
	try {
		const response = await axios.post(`${WP_URL}/posts`, {
			title: title,
			status: 'publish',
			featured_media: imageId
		}, {
			headers: { Authorization: `Basic ${auth}` }
		});
		return response.data.link;
	} catch (error) {
		console.error('Ошибка создания поста:', error.response?.data || error);
		return null;
	}
}

// Обработчик очереди
uploadQueue.process(async (job) => {
	const { userId, username, fullName, photoPath } = job.data;
	console.log(`Обрабатываем фото от ${username} (${userId})...`);

	const imageData = await uploadToWordPress(photoPath);
	fs.unlinkSync(photoPath); // Удаляем временный файл

	if (imageData && imageData.id) {
		const postLink = await createPost(fullName, imageData.id);
		console.log(`Фото успешно загружено!`);
	} else {
		console.log(`Ошибка загрузки фото от ${username}`);
	}
});

console.log('Очередь обработки запущена!');