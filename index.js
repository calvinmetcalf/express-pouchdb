
var express   = require('express')
  , rawBody   = require('raw-body')
  , fs        = require('fs')
  , path      = require('path')
  , extend    = require('extend')
  , pkg       = require('./package.json')
  , dbs       = {}
  , uuids     = require('./uuids')
  , histories = {}
  , app       = express();

var Pouch;
module.exports = function(PouchToUse) {
  Pouch = PouchToUse;
  require('pouchdb-all-dbs')(Pouch);
  Pouch.plugin(require('pouchdb-rewrite'));
  Pouch.plugin(require('pouchdb-list'));
  Pouch.plugin(require('pouchdb-show'));
  Pouch.plugin(require('pouchdb-update'));
  Pouch.plugin(require('pouchdb-validation'));
  return app;
};

function registerDB(name, db) {
  db.installValidationMethods();
  dbs[name] = db;
}

function setDBOnReq(db_name, req, res, next) {
  var name = encodeURIComponent(db_name);

  if (name in dbs) {
    req.db = dbs[name];
    return next();
  }

  Pouch.allDbs(function (err, dbs) {
    if (err) {
      return res.send(500, err);
    } else if (dbs.indexOf(name) === -1) {
      return res.send(404, {
        status: 404,
        error: 'not_found',
        reason: 'no_db_file'
      });
    }
    new Pouch(name, function (err, db) {
      if (err) return res.send(412, err);
      registerDB(name, db);
      req.db = db;
      return next();
    });
  });
}

function expressReqToCouchDBReq(req) {
  return {
    body: req.rawBody || "undefined",
    cookie: req.cookies || {},
    headers: req.headers,
    method: req.method,
    peer: req.ip,
    query: req.query
  };
}

function sendCouchDBResp(res, err, couchResp) {
    if (err) return res.send(err.status, err);

    res.set(couchResp.headers);
    var body;
    if (couchResp.base64) {
      body = new Buffer(couchResp.base64, 'base64');
    } else {
      body = couchResp.body;
    }
    res.send(couchResp.code, body);
}

app.use('/js', express.static(__dirname + '/fauxton/js'));
app.use('/css', express.static(__dirname + '/fauxton/css'));
app.use('/img', express.static(__dirname + '/fauxton/img'));

app.use(function (req, res, next) {
  var opts = {}
    , data = ''
    , prop;

  // Normalize query string parameters for direct passing
  // into Pouch queries.
  for (prop in req.query) {
    try {
      req.query[prop] = JSON.parse(req.query[prop]);
    } catch (e) {}
  }
  // Custom bodyParsing because express.bodyParser() chokes
  // on 'malformed' requests, and also because we need the
  // rawBody for attachments
  rawBody(req, {
    length: req.headers['content-length']
  }, function (err, string) {
    if (err)
      return next(err)

    req.rawBody = string
    try {
      req.body = JSON.parse(string.toString('utf8'))
    } catch (err) {}
    next()
  })
});
app.use(function (req, res, next) {
  var _res = res;
  var send = res.send;
  res.send = function() {
    var args = Array.prototype.slice.call(arguments).map(function (arg) {
      if (arg && arg.name && arg.message) {
        var _arg = {
          error: arg.name,
          reason: arg.message
        };
        return _arg;
      }
      return arg;
    });
    send.apply(_res, args);
  };
  next();
});

// Query design document rewrite handler
app.use(function (req, res, next) {
  // Prefers regex over setting the first argument of app.use(), because
  // the last makes req.url relative, which in turn makes most rewrites
  // impossible.
  var match = /\/([^\/]*)\/_design\/([^\/]*)\/_rewrite(.*)/.exec(req.url);
  if (!match) {
    return next();
  }
  setDBOnReq(match[1], req, res, function () {
    var query = match[2] + "/" + match[3];
    var opts = expressReqToCouchDBReq(req);
    req.db.rewriteResultRequestObject(query, opts, function (err, resp) {
      if (err) return res.send(err.status, err);
      req.rawBody = resp.body;
      req.cookies = resp.cookie;
      req.headers = resp.headers;
      req.method = resp.method;
      req.ip = resp.peer;
      req.url = "/" + resp.path.join("/");
      req.query = resp.query;

      //handle the newly generated request.
      next();
    });
  });
});

// Root route, return welcome message
app.get('/', function (req, res, next) {
  res.send(200, {
    'express-pouchdb': 'Welcome!',
    'version': pkg.version
  });
});

app.get('/_session', function (req, res, next) {
  res.send({"ok":true,"userCtx":{"name":null,"roles":["_admin"]},"info":{}});
});

app.get('/_utils', function (req, res, next) {
  res.sendfile(__dirname + '/fauxton/index.html');
});

// Config (stub for now)
app.get('/_config', function (req, res, next) {
  res.send(200, {
    facts: { 
        "pouchdb-server has no config": true,
        "if you use pouchdb-server, you are awesome": true
      }
  });
});

app.put('/_config/:key/:value(*)', function (req, res, next) {
  res.send(200, {ok: true, 'pouchdb-server has no config': true});
});

// Log (stub for now)
app.get('/_log', function (req, res, next) {
  // TODO: implement
  res.send(200, '_log is not implemented yet. PRs welcome!');
});

// Log (stub for now)
app.get('/_stats', function (req, res, next) {
  // TODO: implement
  res.send(200, {'pouchdb-server' : 'has not impemented _stats yet. PRs welcome!'});
});

app.get('/_active_tasks', function (req, res, next) {
  // TODO: implement
  res.send(200, []);
});

// Generate UUIDs
app.get('/_uuids', function (req, res, next) {
  var count = typeof req.query.count === 'number' ? req.query.count : 1;
  res.send(200, {
    uuids: uuids(count)
  });
});

// List all databases.
app.get('/_all_dbs', function (req, res, next) {
  Pouch.allDbs(function (err, response) {
    if (err) res.send(500, Pouch.UNKNOWN_ERROR);
    res.send(200, response);
  });
});

// Replicate a database
app.post('/_replicate', function (req, res, next) {

  var source = req.body.source
    , target = req.body.target
    , opts = { continuous: !!req.body.continuous };

  if (req.body.filter) opts.filter = req.body.filter;
  if (req.body.query_params) opts.query_params = req.body.query_params;

  var startDate = new Date();
  Pouch.replicate(source, target, opts).then(function (response) {
    
    var historyObj = extend(true, {
      start_time: startDate.toJSON(),
      end_time: new Date().toJSON(),
    }, response);
    
    var currentHistories = [];
    
    if (!/^https?:\/\//.test(source)) {
      histories[source] = histories[source] || [];
      currentHistories.push(histories[source]);

    }
    if (!/^https?:\/\//.test(target)) {
      histories[target] = histories[target] || [];
      currentHistories.push(histories[target]);
    }
    
    currentHistories.forEach(function (history) {
      // CouchDB caps history at 50 according to
      // http://guide.couchdb.org/draft/replication.html
      history.push(historyObj);
      if (history.length > 50) {
        history.splice(0, 1); // TODO: this is slow, use a stack instead
      }      
    });
    
    response.history = histories[source] || histories[target] || [];
    res.send(200, response);
  }, function (err) {
    res.send(400, err);
  });

  // if continuous pull replication return 'ok' since we cannot wait for callback
  if (target in dbs && opts.continuous) {
    res.send(200, { ok : true });
  }

});

// Create a database.
app.put('/:db', function (req, res, next) {
  var name = encodeURIComponent(req.params.db);

  if (name in dbs) {
    return res.send(412, {
      'error': 'file_exists',
      'reason': 'The database could not be created.'
    });
  }

  new Pouch(name, function (err, db) {
    if (err) return res.send(412, err);
    registerDB(name, db);
    var loc = req.protocol
      + '://'
      + ((req.host === '127.0.0.1') ? '' : req.subdomains.join('.') + '.')
      + req.host
      + '/' + name;
    res.location(loc);
    res.send(201, { ok: true });
  });
});

// Delete a database
app.delete('/:db', function (req, res, next) {
  var name = encodeURIComponent(req.params.db);
  Pouch.destroy(name, function (err, info) {
    if (err) return res.send(err.status || 500, err);
    delete dbs[name];
    res.send(200, { ok: true });
  });
});

// At this point, some route middleware can take care of identifying the
// correct Pouch instance.
['/:db/*','/:db'].forEach(function (route) {
  app.all(route, function (req, res, next) {
    setDBOnReq(req.params.db, req, res, next);
  });
});

// Get database information
app.get('/:db', function (req, res, next) {
  req.db.info(function (err, info) {
    if (err) return res.send(404, err);
    res.send(200, info);
  });
});

// Bulk docs operations
app.post('/:db/_bulk_docs', function (req, res, next) {

  // Maybe this should be moved into the leveldb adapter itself? Not sure
  // how uncommon it is for important options to come through in the body
  // https://github.com/daleharvey/pouchdb/issues/435
  var opts = 'new_edits' in req.body
    ? { new_edits: req.body.new_edits }
    : null;

  if (Array.isArray(req.body)) {
    return res.send(400, {
      error: "bad_request",
      reason: "Request body must be a JSON object"
    });
  }

  req.db.bulkDocs(req.body, opts, function (err, response) {
    if (err) return res.send(500, err);
    res.send(201, response);
  });

});

// All docs operations
app.all('/:db/_all_docs', function (req, res, next) {
  if (req.method !== 'GET' && req.method !== 'POST') return next();

  // Check that the request body, if present, is an object.
  if (!!req.body && (typeof req.body !== 'object' || Array.isArray(req.body))) {
    return res.send(400, Pouch.BAD_REQUEST);
  }

  for (var prop in req.body) {
    req.query[prop] = req.query[prop] || req.body[prop];
  }

  req.db.allDocs(req.query, function (err, response) {
    if (err) return res.send(400, err);
    res.send(200, response);
  });

});

// Monitor database changes
app.get('/:db/_changes', function (req, res, next) {

  // api.changes expects a property `query_params`
  // This is a pretty inefficient way to do it.. Revisit?
  req.query.query_params = JSON.parse(JSON.stringify(req.query));

  function longpoll(err, data) {
    if (err) return res.send(err.status, err);
    if (data.results && data.results.length) {
      data.last_seq = Math.max.apply(Math, data.results.map(function (r) {
        return r.seq;
      }));
      res.send(200, data);
    } else {
      delete req.query.complete;
      req.query.live = true;
      var query = req.db.changes(req.query);
      query.once('change', function (change) {
        res.send(200, change);
        query.cancel();
      });
    }
  }

  if (req.query.feed) {
    req.socket.setTimeout(86400 * 1000);
    req.query.complete = longpoll;
  } else {
    req.query.complete = function (err, response) {
      if (err) return res.send(err.status, err);
      res.send(200, response);
    };
  }

  req.db.changes(req.query);

});

// DB Compaction
app.post('/:db/_compact', function (req, res, next) {
  req.db.compact(function (err, response) {
    if (err) return res.send(500, err);
    res.send(200, response);
  });
});

// Revs Diff
app.post('/:db/_revs_diff', function (req, res, next) {
  req.db.revsDiff(req.body || {}, function (err, diffs) {
    if (err) return res.send(400, err);

    res.send(200, diffs);
  });
});

// Temp Views
app.post('/:db/_temp_view', function (req, res, next) {
  if (req.body.map) req.body.map = (new Function('return ' + req.body.map))();
  req.query.conflicts = true;
  req.db.query(req.body, req.query, function (err, response) {
    if (err) return res.send(400, err);
    res.send(200, response);
  });
});

// Query design document info
app.get('/:db/_design/:id/_info', function (req, res, next) {
  // Dummy data for Fauxton
  res.send(200, {
    'name': req.query.id,
    'view_index': 'Not implemented.'
  });
});

// Query a document view
app.get('/:db/_design/:id/_view/:view', function (req, res, next) {
  var query = req.params.id + '/' + req.params.view;
  req.db.query(query, req.query, function (err, response) {
    if (err) return res.send(404, err);
    res.send(200, response);
  });
});

// Query design document list handler
app.all('/:db/_design/:id/_list/:func/:view', function (req, res, next) {
  var query = [req.params.id, req.params.func, req.params.view].join("/");
  var opts = expressReqToCouchDBReq(req);
  req.db.list(query, opts, sendCouchDBResp.bind(null, res));
});

// Query design document show handler
app.all('/:db/_design/:id/_show/:func/:docid?', function (req, res, next) {
  var query = [req.params.id, req.params.func, req.params.docid].join("/");
  var opts = expressReqToCouchDBReq(req);
  req.db.show(query, opts, sendCouchDBResp.bind(null, res));
});

// Query design document update handler
app.all('/:db/_design/:id/_update/:func/:docid?', function (req, res, next) {
  var query = [req.params.id, req.params.func, req.params.docid].join("/");
  var opts = expressReqToCouchDBReq(req);
  req.db.update(query, opts, sendCouchDBResp.bind(null, res));
});

// Put a document attachment
app.put('/:db/:id/:attachment(*)', function (req, res, next) {

  // Be careful not to catch normal design docs or local docs
  if (req.params.id === '_design' || req.params.id === '_local') {
    return next();
  }
  var name = req.params.id
    , attachment = req.params.attachment
    , rev = req.query.rev
    , type = req.get('Content-Type') || 'application/octet-stream'
    , body = new Buffer(req.rawBody || '', 'binary')

  req.db.putAttachment(name, attachment, rev, body, type, function (err, response) {
    if (err) return res.send(409, err);
    res.send(200, response);
  });
});

// Retrieve a document attachment
app.get('/:db/:id/:attachment(*)', function (req, res, next) {

  // Be careful not to catch normal design docs or local docs
  if (req.params.id === '_design' || req.params.id === '_local') {
    return next();
  }

  var name = req.params.id
    , attachment = req.params.attachment;

  req.db.get(req.params.id, req.query, function (err, info) {
    if (err) return res.send(404, err);

    if (!info._attachments || !info._attachments[attachment]) {
      return res.send(404, {status:404, error:'not_found', reason:'missing'});
    };

    var type = info._attachments[attachment].content_type;
 
    req.db.getAttachment(name, attachment, function (err, response) {
      if (err) return res.send(409, err);
      res.set('Content-Type', type);
      res.send(200, response);
    });    
  });
});

// Delete a document attachment
app.delete('/:db/:id/:attachment(*)', function (req, res, next) {

  // Be careful not to catch normal design docs or local docs
  if (req.params.id === '_design' || req.params.id === '_local') {
    return next();
  }

  var name = req.params.id
    , attachment = req.params.attachment
    , rev = req.query.rev;

  req.db.removeAttachment(name, attachment, rev, function (err, response) {
    if (err) return res.send(409, err);
    res.send(200, response);
  });
});

// Create or update document that has an ID
app.put('/:db/:id(*)', function (req, res, next) {
  req.body._id = req.body._id || req.query.id;
  if (!req.body._id) {
    req.body._id = (!!req.params.id && req.params.id !== 'null')
      ? req.params.id
      : null;
  }
  req.db.put(req.body, req.query, function (err, response) {
    if (err) return res.send(err.status || 500, err);
    var loc = req.protocol
      + '://'
      + ((req.host === '127.0.0.1') ? '' : req.subdomains.join('.') + '.')
      + req.host
      + '/' + req.params.db
      + '/' + req.body._id;
    res.location(loc);
    res.send(201, response);
  });
});

// Create a document
app.post('/:db', function (req, res, next) {
  req.body._id = uuids(1)[0];
  req.db.put(req.body, req.query, function (err, response) {
    if (err) return res.send(err.status || 500, err);
    res.send(201, response);
  });
});

// Retrieve a document
app.get('/:db/:id(*)', function (req, res, next) {
  req.db.get(req.params.id, req.query, function (err, doc) {
    if (err) return res.send(404, err);
    res.send(200, doc);
  });
});

// Delete a document
app.delete('/:db/:id(*)', function (req, res, next) {
  req.db.get(req.params.id, req.query, function (err, doc) {
    if (err) return res.send(404, err);
    req.db.remove(doc, function (err, response) {
      if (err) return res.send(404, err);
      res.send(200, response);
    });
  });
});

// Copy a document
app.copy('/:db/:id', function (req, res, next) {
  var dest = req.get('Destination')
    , rev
    , match;

  if (!dest) {
    return res.send(400, {
      'error': 'bad_request',
      'reason': 'Destination header is mandatory for COPY.'
    });
  }

  if (match = /(.+?)\?rev=(.+)/.exec(dest)) {
    dest = match[1];
    rev = match[2];
  }

  req.db.get(req.params.id, req.query, function (err, doc) {
    if (err) return res.send(404, err);
    doc._id = dest;
    doc._rev = rev;
    req.db.put(doc, function (err, response) {
      if (err) return res.send(409, err);
      res.send(200, doc);
    });
  });
});
