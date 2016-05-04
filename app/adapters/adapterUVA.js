'use strict';

const cheerio = require('cheerio'),
      assert  = require('assert'),
      async   = require('async'),
      path    = require('path');

const Adapter       = require('../adapters/adapter'),
      Errors        = require('../utils/errors'),
      RequestClient = require('../utils/requestClient'),
      Util          = require('../utils/util');

const HOST              = "uva.onlinejudge.org",
      SUBMIT_PAGE_PATH  = "/index.php?option=com_onlinejudge&Itemid=25",
      SUBMIT_PATH       = "/index.php?option=com_onlinejudge&Itemid=25&page=save_submission",
      SUBMISSIONS_PATH  = "/index.php?option=com_onlinejudge&Itemid=9";

const LOGGED_PATTERN          = /My\s+Account/i,
      LOGIN_FORM_PATTERN      = /<form([^>]+?id\s*=\s*["']?\w*mod_loginform[^>]*)>((?:.|\r|\n)*?)<\/form>/i,
      NOT_AUTHORIZED_PATTERN  = /not\s+authori[zs]ed/i;

const TYPE = /^adapter(\w+)/i.exec(path.basename(__filename))[1].toLowerCase();

module.exports = ((parentCls) => {

  function AdapterUVA(acct) {
    parentCls.call(this, acct);

    const client = new RequestClient('https', HOST);

    function login(callback) {
      async.waterfall([
        (next) => {
          client.get('/', next);
        },
        (res, html, next) => {
          let f, opts;
          try {
            f = Util.parseForm(LOGIN_FORM_PATTERN, html);
            f.data[f.userField] = acct.getUser();
            f.data[f.passField] = acct.getPass();
            opts = {
              followAllRedirects: true,
              headers: { Referer: 'https://' + HOST, },
            };
          } catch (e) {
            return next(Errors.SubmissionFail, res, html);
          }
          return client.post(f.action, f.data, opts, next);
        }
      ], (err, res, html) => {
        html = html || '';
        if (!html.match(LOGGED_PATTERN)) {
          return callback(Errors.LoginFail);
        }
        return callback();
      });
    };

    this._login = login;

    function send(submission, retry, callback) {
      let data = {
        localid: submission.problemId,
        code: submission.code,
        language: submission.language,
        codeupl: '',
        problemid: '',
        category: '',
      };
      let opts = {
        headers: {
          Referer: 'https://' + HOST + SUBMIT_PAGE_PATH,
        },
      };
      client.postMultipart(SUBMIT_PATH, data, opts, (err, res, html) => {
        if (err) return callback(err);
        html = html || '';
        if (html.match(NOT_AUTHORIZED_PATTERN)) {
          if (!retry) {
            return callback(Errors.SubmissionFail);
          } else {
            return login((err) => {
              if (err) return callback(err);
              return send(submission, false, callback);
            });
          }
        }
        let id;
        try {
          id = /([0-9]{6,15})/.exec(res.req.path)[0];
          assert(id && id.length >= 6);
        } catch (err) {
          return callback(Errors.SubmissionFail);
        }
        return callback(null, id);
      });
    };

    this._send = (submission, callback) => {
      return send(submission, true, callback);
    }

    function judge(judgeSet, callback) {
      client.get(SUBMISSIONS_PATH, (err, res, html) => {
        html = html || '';
        if (!html.match(LOGGED_PATTERN)) {
          return login(callback);
        }
        let $ = cheerio.load(html);
        for (let id in judgeSet) {
          let data = null;
          try {
            data = $('td:contains("' + id + '")');
            data = data.nextAll().eq(2);
            if (!data.find('a').html()) {
              data = data.html();
            } else {
              data = data.find('a').html();
            }
            judgeSet[id].verdict = data;
          } catch(e) {}
        }
        return callback();
      });
    }

    this._judge = judge;
  }

  // Problems Fetcher
  (function(obj) {
    const VOLUMES = ["/index.php?option=com_onlinejudge&Itemid=8&category=1",
                     "/index.php?option=com_onlinejudge&Itemid=8&category=2"];
    const PROBLEM_PATTERN = /^(\d+)\s*-\s*(.*)/i;
    const client = new RequestClient('https', HOST);

    function reduceProblems(problems, href, callback) {
      client.get(href, (err, res, html) => {
        html = html || '';
        let $ = cheerio.load(html);
        $('tr.sectiontableheader').nextAll().each((i, elem) => {
          elem = $(elem).children().eq(2).text();
          let res = PROBLEM_PATTERN.exec(elem);
          if (res && res[1] && res[2]) {
            problems.push({
              id: res[1],
              name: res[2],
              oj: TYPE
            });
          }
        });
        return callback(null, problems);
      });
    }

    function reduceVolumes(problems, volumePath, callback) {
      async.waterfall([
        (next) => {
          client.get(volumePath, next);
        },
        (res, html, next) => {
          html = html || '';
          let $ = cheerio.load(html);
          let volumesHref = [];
          $('a:contains("Volume ")').each((i, elem) => {
            volumesHref.push('/' + $(elem).attr('href'));
          });
          async.reduce(volumesHref, problems, reduceProblems, next);
        }
      ], callback);
    }

    obj.fetchProblems = (callback) => {
      async.reduce(VOLUMES, [], reduceVolumes, callback);
    }
  })(AdapterUVA);

  return AdapterUVA;
})(Adapter);
