require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const Queue = require('bull');
const rateLimit = require('telegraf-ratelimit');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// Конфигурация из .env
const bot = new Telegraf(process.env.BOT_API_KEY_MAIN);
bot.use(session());
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;

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

// Очистка сообщения
const sanitizeInput = (input) => input.replace(/[<>]/g, '');

// Ограничение запросов
const limitConfig = {
	window: 10000, // за 10 секунд
	limit: 20, // 20 сообщений
	onLimitExceeded: (ctx) => ctx.reply('Слишком много запросов. Подождите немного.'),
};
bot.use(rateLimit(limitConfig));

// Команда /start
bot.start((ctx) => {
	ctx.session = {};
	ctx.session.start = true;
	logToFile(`${ctx.from.username} [${ctx.from.id}]: Начало сессии`);
	ctx.reply(
		'Привет, коллега! Я Веснушка - бот для загрузки изображений на электронную фотомозаику «Весна в ТеДо». Вместе мы создадим огромную онлайн-фотогалерею команды ТеДо. Все, кто загрузит фото, примут участие в розыгрыше призов! Я буду готова принять твое фото 6 марта, в День весны в ТеДо 💙',
		Markup.keyboard(['Ввести пароль']).oneTime().resize()
	);
});

// Авторизация
bot.on('text', (ctx) => {
	try {
		if (ctx.session.start) {			
			if (ctx.message.text === 'Ввести пароль') {
				ctx.session.start = false;
				ctx.session.password = true;
				ctx.reply('Введите пароль для доступа:');
			} 
			return;
		}

		if (ctx.session.password) {
			if (sanitizeInput(ctx.message.text) === ACCESS_PASSWORD) {
				ctx.session.password = false;
				ctx.session.auth = true;
				logToFile(`${ctx.from.username} [${ctx.from.id}]: Успешная авторизация`);

				// Согласие с политикой
				ctx.replyWithHTML(
					`Даю согласие на обработку моих персональных данных на условиях, изложенных в <a href="https://telegra.ph/Politika-obrabotki-personalnyh-dannyh-03-03">Политике</a>.`,
					Markup.keyboard(['Принять политику конфиденциальности']).oneTime().resize()
				);
			} else {
				logToFile(`${ctx.from.username} [${ctx.from.id}]: Неверный пароль`);
				ctx.reply('Неверный пароль. Попробуйте снова.');
			}
			return;
		}

		if (ctx.session.auth) {
			if (ctx.message.text === 'Принять политику конфиденциальности') {
				ctx.session.auth = false;
				ctx.session.policyAccept = true;
				ctx.reply(
					'Давайте расскажу, какая фотография подходит для загрузки.',
					Markup.keyboard(['Все понятно, готов загрузить фотографию']).oneTime().resize()
				);
			} else {
				ctx.reply('Пожалуйста, используйте кнопки для продолжения.');
			}
			return;
		}

		if (ctx.session.policyAccept) {
			if (ctx.message.text === 'Все понятно, готов загрузить фотографию') {
				ctx.session.policyAccept = false;
				ctx.session.rulesAccept = true; 
				ctx.reply('Введите свой ник в Telegram, который будет отображаться в фотогалерее.');
			} else {
				ctx.reply('Пожалуйста, используйте кнопки для продолжения.');
			}
			return;
		}

		if (ctx.session.rulesAccept) {
			ctx.session.rulesAccept = false; 
			ctx.session.fullName = sanitizeInput(ctx.message.text);
			logToFile(`${ctx.from.username} [${ctx.from.id}]: Ввел ник: ${ctx.message.text}`);
			ctx.reply('Теперь отправьте фото. Если что, мне нужна только одна фотография. Пожалуйста, не прикрепляйте фото как документ. Максимальный размер фото — 2 МБ.');
			return; 
		}

		// Если пользователь отправляет произвольное сообщение
		ctx.reply('Пожалуйста, используйте кнопки для продолжения.');
	} catch (error) {
		console.error('Ошибка при обработке текста:', error);
		logToFile(`${ctx.from.username} [${ctx.from.id}] Ошибка при обработке текста: ${error.message}`);
		ctx.reply('Произошла ошибка. Попробуйте позже.');
		ctx.session = {};
	}
});

// Обработчик фото
bot.on('photo', async (ctx) => {
	try {
		if (ctx.session.password) {
			return ctx.reply('Сначала введите пароль.');
		} 
		if (ctx.session.policyAccept || ctx.session.auth) {
			return ctx.reply('Пожалуйста, используйте кнопки для продолжения.');
		} 
		if (ctx.session.rulesAccept) {
			return ctx.reply('Сначала введите ваш ник.');
		} 

		// Проверка на количество фото
		if (ctx.message.media_group_id) {
			console.log(`${ctx.from.username} [${ctx.from.id}]: Попытка отправить несколько фото`);
			logToFile(`${ctx.from.username} [${ctx.from.id}]: Попытка отправить несколько фото`);
			ctx.reply('Пожалуйста, отправляйте только одно изображение за раз');
			return;
		}

		// Ограничение файла в 2Мб
		if (ctx.message.photo && ctx.message.photo.length > 0) {
			const fileSize = ctx.message.photo.pop().file_size;
			if (fileSize > 2097152) {
				ctx.reply('Файл слишком большой. Максимальный размер — 2 МБ.');
				return;
			}
		}

		const fileId = ctx.message.photo.pop().file_id;
		const fileUrl = await ctx.telegram.getFileLink(fileId);
		const localPath = path.join(__dirname, `photo_${ctx.from.id}.jpg`);
		const response = await axios({ url: fileUrl.href, responseType: 'stream' });
		const writer = fs.createWriteStream(localPath);
		response.data.pipe(writer);

		writer.on('finish', async () => {
			console.log('Принято фото от пользователя.');
			logToFile(`${ctx.from.username} [${ctx.from.id}] Загружает фото.`);

			// Сохраняем путь к фото в сессии
			ctx.session.photoPath = localPath;

			// Отправляем сообщение с подтверждением и кнопками
			ctx.reply('Подтвердите фото и ник.', Markup.inlineKeyboard([
				Markup.button.callback('Изменить', 'change_photo'),
				Markup.button.callback('Отправить', 'submit_photo')])
			);
		});
	} catch (error) {
		console.error('Ошибка при обработке фото:', error);
		logToFile(`${ctx.from.username} [${ctx.from.id}] Ошибка обработки фото: ${error.message}`);
		ctx.reply('Произошла ошибка при обработке фото. Попробуйте снова.');
	}
});

// Обработчик файлов
bot.on('document', (ctx) => {
	if (ctx.session.password) {
		return ctx.reply('Сначала введите пароль.');
	} 
	if (ctx.session.policyAccept || ctx.session.auth) {
		return ctx.reply('Пожалуйста, используйте кнопки для продолжения.');
	} 
	if (ctx.session.rulesAccept) {
		return ctx.reply('Сначала введите ваш ник.');
	} 
	if (ctx.session.fullName) {
		return ctx.reply('Пожалуйста, отправьте фото как изображение, а не как файл.');
	}
});

// Обработчик inline-кнопок
bot.action('change_photo', async (ctx) => {
	try {
		// Удаляем загруженное фото
		if (ctx.session.photoPath) {
			fs.unlinkSync(ctx.session.photoPath); // Удаляем файл
			delete ctx.session.photoPath; // Очищаем путь из сессии
		}

		// Очищаем ник
		delete ctx.session.fullName;

		// Возвращаем пользователя к шагу ввода ника
		ctx.session.rulesAccept = true; 
		ctx.reply('Введите Ваш ник, который будет отображаться в фотогалерее.');
	} catch (error) {
		console.error('Ошибка при обработке кнопки "Изменить":', error);
		logToFile(`${ctx.from.username} [${ctx.from.id}] Ошибка при обработке кнопки "Изменить": ${error.message}`);
		ctx.reply('Произошла ошибка. Попробуйте снова.');
	}
});

bot.action('submit_photo', async (ctx) => {
	try {
		// Передаем задачу в очередь
		await photoQueue.add({
			fullName: ctx.session.fullName,
			photoPath: ctx.session.photoPath,
			userId: ctx.from.id,
		});

		// Отправляем финальное сообщение
		ctx.reply('Отлично! Ваши данные отправлены, удачи в конкурсе.');

		// Очищаем сессию
		ctx.session = {};
	} catch (error) {
		console.error('Ошибка при обработке кнопки "Отправить":', error);
		logToFile(`${ctx.from.username} [${ctx.from.id}] Ошибка при обработке кнопки "Отправить": ${error.message}`);
		ctx.reply('Произошла ошибка. Попробуйте снова.');
	}
});

// Глобальный предохранитель
bot.catch((err, ctx) => {
	console.error(`Ошибка у пользователя ${ctx.from.id}:`, err);
	logToFile(`Ошибка у пользователя ${ctx.from.username} [${ctx.from.id}]: ${err.message}`);
	ctx.reply('Произошла ошибка. Попробуйте начать заново с командой /start.');
	ctx.session = {};
});

// Запуск бота
bot.launch();
console.log('Бот запущен!');