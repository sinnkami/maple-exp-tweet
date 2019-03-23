const moment = require('moment');
const request = require('request');
const cheerio = require('cheerio');
const deepcopy = require('deepcopy');
const Datastore = require('nedb-promises');
const Twitter = require("twitter");
const Botkit = require('botkit');
const schedule = require('node-schedule');

const twitter = new Twitter({
  consumer_key: process.env.twitterConsumerKey,
  consumer_secret: process.env.twitterConsumerSecret,
  access_token_key: process.env.twitterAccessToken,
  access_token_secret: process.env.twitterAccessTokenSecret,
});

const controller = Botkit.slackbot({ debug: false });
const bot = controller.spawn({ token: process.env.slackToken });
function start_rtm() {
    bot.startRTM((err,bot,payload) => {
        if (err) {
            console.log('Failed to start RTM')
            return setTimeout(start_rtm, 60000);
        }
        console.log("RTM started!");
    });
};

controller.on('rtm_close', (bot, err) => {
    start_rtm();
});

start_rtm();

const config = {
  // 時間のフォーマット
  dateFormat: "YYYY年MM月DD日",
  defaultChannel: "#bot-test",
  // メイプル関連の文字
  mapleSelecter: "(maple|maplestory|メイプル|メイプルストーリー)",
  // ワールド
  world: {
    "かえで"  : 0,
    "くるみ"  : 1,
    "ゆかり"  : 2,
    "リブート": 45,
  },
  // メイプル用のDBテーブル
  mapleInitDBTable: {
    name: "",
    level: 0,
    job: "",
    world: "",
    exp: 0,
    expPersent: 0,
    updateTime: ""
  },
  ExpDB: Datastore.create(`${process.cwd()}/db/level.db`),
};

// 毎日0時にツイート処理を行う
schedule.scheduleJob("0 0 * * *", auto_tweet);
function auto_tweet() {
  const DB = Datastore.create(`${process.cwd()}/db/maplestory.db`);
  const yesterday = moment().add(-1, "days").format(config.dateFormat);
  DB.find({updateTime: yesterday}).then(function (docs) {
    const promises = [];
    for (const doc of docs) {
      promises.push(new Promise((resolve, reject) => {
        DB.findOne({name: doc.name, updateTime: moment().add(-2, "days").format(config.dateFormat)}).then(function (data) {
          Promise.all([getExpPersent(data.level, data.exp), getExpPersent(doc.level, doc.exp)]).then(function ([before, after]) {
            if (!before) { before = parseFloat(data.expPersent); }
            if (!after) { after = parseFloat(doc.expPersent); }

            const level = data.level < doc.level ? `${data.level} -> ${doc.level} UP!` : `${doc.level}`;
            const expPersent = `${before}% -> ${after}%`;
            return resolve({
              text: `${doc.name} (${doc.world} / ${doc.job})\nlevel: ${level}\nexp: ${expPersent}\n`,
              level: doc.level,
              exp: doc.exp,
              show: (data.level < doc.level || before < after) ? true : false,
            });
          })
        })
      }))
    }
    Promise.all(promises).then(function (docs) {
      docs.sort(function(a,b){
        if( a.level > b.level ) return -1;
        if( a.level < b.level ) return 1;
        if( a.exp > b.exp ) return -1;
        if( a.exp < b.exp ) return 1;
        return 0;
      });
      console.log(docs);
      let message = `${yesterday}\n`;
      message += docs[0].text;
      if (docs.length > 1) { message += `他リプライへ\n`; }

      message += "※自作なので壊れてる可能性があります\n";
      message += "#JMSRankingTweet";
      docs[0].text = message;
      tweet(docs);
    })
  })
}

// 毎日1時に昔のデータを削除する
// また、その日のデータを用意する
schedule.scheduleJob("0 1 * * *", set_today_data);
function set_today_data() {
  const DB = Datastore.create(`${process.cwd()}/db/maplestory.db`);
  const deleteDate = moment().add(-3, "days");
  DB.find({}).then(function (docs) {
    for (const doc of docs) {
      if (moment(deleteDate).isAfter(moment(doc.updateTime, config.dateFormat))) {
        DB.remove({_id: doc._id});
      }
    }
  })
  DB.find({updateTime: moment().add(-1, "days").format(config.dateFormat)}).then(function (docs) {
    for (const doc of docs) {
      delete doc._id;
      doc.updateTime = moment().format(config.dateFormat);
      DB.insert(doc);
    }
  })
}

// 毎日7時にランキングから取得する
schedule.scheduleJob("00 7 * * *", function () {
  const DB = Datastore.create(`${process.cwd()}/db/maplestory.db`);
  const today = moment().format(config.dateFormat);
  DB.find({updateTime: today}).then(function (docs) {
    for (const doc of docs) {
      getJMSRanking(doc.name, doc.job, config.world[doc.world]).then(function (data) {
        if (!data) { return; }
        console.log(data);
        doc.level = data.level;
        doc.exp = data.exp;
        doc.updateTime = moment().format(config.dateFormat);
        delete doc._id;
        DB.remove({name: doc.name, updateTime: doc.updateTime}, {multi: true});
        DB.insert(doc);
      })
    }
  })
})


controller.hears([`${config.mapleSelecter} (new|NEW) (.*)`], 'direct_message, direct_mention', (bot, message) => {
  const chara_name = message.match[3];

  const DB = Datastore.create(`${process.cwd()}/db/maplestory.db`);
  const table = deepcopy(config.mapleInitDBTable);
  table.name = chara_name;
  table.world = "かえで";
  table.updateTime = moment().add(-1, "days").format(config.dateFormat);
  DB.insert(table);

  bot.api.chat.postMessage({
      text: `メイプル経験値ツイートに${chara_name}を追加しました！`,
      channel: message.channel,
      as_user: true,
  })
});

controller.hears([`${config.mapleSelecter} (set|SET) (.*) (.*) (.*)`], 'direct_message, direct_mention', (bot, message) => {
  const column = message.match[4];
  if (!column in config.mapleInitDBTable) {
    let keys = Object.keys(config.mapleInitDBTable).join("\n");
    bot.api.chat.postMessage({
        text: `メイプル経験値ツイートには以下のカラムしか存在しません！\n ${keys}`,
        channel: message.channel,
        as_user: true,
    })
    return false;
  }

  const name = message.match[3];
  const value = message.match[5];
  const DB = Datastore.create(`${process.cwd()}/db/maplestory.db`);
  DB.find({name: name}).then(function (docs) {
    let doc = docs[0];
    for (data of docs) {
      if (moment(moment(doc.updateTime, config.dateFormat)).isBefore(moment(data.updateTime, config.dateFormat))) {
        doc = data;
      }
    }
    let returnMessage = "";
    switch (column) {
      case "name":
        returnMessage = `名前を${doc.name}から${value}へ変更しました`;
        doc.name = value;
      break;
      case "job":
        returnMessage = `職業を${doc.job}から${value}へ変更しました`;
        doc.job = value;
      break;
      case "world":
        returnMessage = `ワールドを${doc.world}から${value}へ変更しました`;
        doc.world = value;
      break;
      case "level":
        returnMessage = `レベルを${doc.level}から${value}へ変更しました`;
        doc.level = value;
      break;
      case "exp":
        returnMessage = `経験値を${doc.exp}から${value}へ変更しました`;
        doc.exp = value;
        doc.expPersent = getExpPersent(doc.level, value);
      break;
      case "expPersent":
        returnMessage = `経験値パーセントを${doc.expPersent}から${value}へ変更しました`;
        doc.expPersent = value;
      break;
    }

    doc.updateTime = moment().format(config.dateFormat);
    delete doc._id;
    DB.remove({name: doc.name, updateTime: doc.updateTime}, {multi: true});
    DB.insert(doc).then(function (data) {
      bot.api.chat.postMessage({
          text: returnMessage,
          channel: message.channel,
          as_user: true,
      })
    });


  }).catch(function () {
    bot.api.chat.postMessage({
        text: `メイプル経験値ツイートには${name}は存在していません！`,
        channel: message.channel,
        as_user: true,
    })
  })
})

controller.hears([''], 'direct_message, direct_mention', (bot, message) => {
  console.log("きたよ〜");
  console.log(message);
});

function tweet(messages, replyID = "") {
  if (!messages.length) {
    return bot.api.chat.postMessage({
      text: "メイプル経験値ツイートを行いました！",
      channel: config.defaultChannel,
      as_user: true,
    })
  }
  const content = messages.shift();
  if (!content.show) { return tweet(messages, replyID); }
  twitter.post("statuses/update", {
    status: content.text,
    in_reply_to_status_id: replyID,
  },(err, data) => {
    return tweet(messages, data.id_str);
  });
}

function getExpPersent(level, exp) {
  return new Promise((resolve, reject) => {
    config.ExpDB.findOne({level: Number(level)}).then(function (doc) {
      if(!doc) { return resolve(0); }
      // 小数点第2まで
      const persent = Math.floor((exp / doc.nextExp) * 10000) / 100;
      if (persent > 100) { return resolve(0); }
      return resolve(persent);
    })
  })
}

function getJMSRanking(name, job, world) {
  const url = 'http://hangame.maplestory.nexon.co.jp/ranking/ranking.asp';
  console.log(name, job, world);

  return new Promise((resolve, reject) => {
    const options = request.Options = {
      uri: url,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      form: {
        'ddlWorld': world,
        'ddlJob': job
      },
    };
    request.post(options, (error, response, body) => {
      if (error) { return reject(error); }
      const $ = cheerio.load(body);
      const nameTDs = $('.color00659c');
      nameTDs.each((index, nameTDElement) => {
        const $name = $(nameTDElement);
        const getName = $name.last().text();
        if (getName != name) { return; };

        const $server = $name.next();
        const $job = $server.next();

        const $levelAndExp = $job.next();
        const levelAndExp = $levelAndExp.text().replace(')', '').split(' (');
        const level = parseInt(levelAndExp[0]);
        const exp = parseInt(levelAndExp[1]);
        return resolve({
          level: level,
          exp: exp,
        });
      });
      return resolve(null);
    });
  });
}
