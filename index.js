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
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;

// Функция для записи логов
function logToFile(message) {
	const logFilePath = path.join(__dirname, 'bot_logs.txt');
	const timestamp = new Date().toISOString();
	const logMessage = `[${timestamp}] ${message}\n`;
	fs.appendFile(logFilePath, logMessage, (err) => {
		if (err) console.error('Ошибка записи лога:', err);
	});
}

// Обработчик команды /start
bot.start((ctx) => {
	ctx.session = {};
	logToFile(`${ctx.from.username} [${ctx.from.id}]: Начало сессии`);
	ctx.reply('Привет! Я — загрузчик фотографий ТеДо. Для начала работы отправьте пароль в сообщении.');
});

// Обработчик сообщений
bot.on('text', async (ctx) => {
	try {
		if (!ctx.session.accessGranted) {
			if (ctx.message.text === ACCESS_PASSWORD) {
				ctx.session.accessGranted = true;
				logToFile(`${ctx.from.username} [${ctx.from.id}]: Успешная авторизация`);
				return ctx.reply('Теперь отправьте ваше фото.');
			} else {
				logToFile(`${ctx.from.username} [${ctx.from.id}]: Неверный пароль`);
				return ctx.reply('Неверный пароль. Попробуйте снова.');
			}
		}

		if (!ctx.session.photoPath) {
			return ctx.reply('Сначала отправьте фото.');
		}

		const fullName = ctx.message.text;
		logToFile(`${ctx.from.username} [${ctx.from.id}]: ${ctx.message.text}`);

		// Отправляем фото в очередь для обработки
    await uploadQueue.add({ userId: ctx.from.id, username: ctx.from.username, fullName, photoPath: ctx.session.photoPath });

		ctx.reply(`Загружаем данные на сайт...`);

		const imageData = await uploadToWordPress(ctx.session.photoPath);
		fs.unlinkSync(ctx.session.photoPath); 

		if (imageData && imageData.id) {
			const postLink = await createPost(fullName, imageData.id);
			logToFile(`${ctx.from.username} [${ctx.from.id}]: Фото загружено`);
			ctx.reply(postLink ? 'Фото успешно загружено! Для новой загрузки воспользуйтесь командой /start.' : 'Ошибка создания поста.');
		} else {
			logToFile(`${ctx.from.username} [${ctx.from.id}]: Ошибка загрузки фото`);
			ctx.reply('Ошибка загрузки изображения на сайт.');
		}
		ctx.session = {}; 
	} catch (error) {
		logToFile(`${ctx.from.username} [${ctx.from.id}]: Ошибка во время обработки текста`);
		ctx.reply('Произошла ошибка. Начните заново с команды /start.');
	}
});

// Обработчик фотографий
bot.on('photo', async (ctx) => {
	try {
		if (!ctx.session.accessGranted) {
			return ctx.reply('Сначала введите пароль для доступа.');
		}

		const fileId = ctx.message.photo.pop().file_id;
		const fileUrl = await ctx.telegram.getFileLink(fileId);
		const localPath = path.join(__dirname, `temp_${ctx.from.id}.jpg`);
		const response = await axios({ url: fileUrl.href, responseType: 'stream' });
		const writer = fs.createWriteStream(localPath);

		response.data.pipe(writer);

		writer.on('finish', () => {
			ctx.session.photoPath = localPath;
			logToFile(`${ctx.from.username} [${ctx.from.id}]: Прикреплено фото`);
			ctx.reply('Теперь напишите ФИО.');
		});
	} catch (error) {
		console.error('Ошибка обработки фото:', error);
		logToFile(`${ctx.from.username} [${ctx.from.id}]: Ошибка обработки фото`);
		ctx.reply('Ошибка обработки фото. Попробуйте снова.');
	}
});

// Обработчик файлов
bot.on('document', (ctx) => {
	if (!ctx.session.accessGranted) {
		return ctx.reply('Сначала введите пароль для доступа.');
	} else {
    ctx.reply('Прикрепите фото как изображение, а не как файл.');
	}
});



// Глобальный предохранитель
bot.catch((err, ctx) => {
	console.error(`Ошибка у пользователя ${ctx.from.id}:`, err);
	logToFile(`Ошибка у пользователя ${ctx.from.username} [${ctx.from.id}]: ${err.message}`);
	ctx.reply('Произошла ошибка. Попробуйте начать заново с командой /start.');
});

// Запуск бота
bot.launch();
console.log('Бот запущен!');
