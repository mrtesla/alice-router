if (process.env['AIRBRAKE_KEY']) {
  var airbrake = require('airbrake');
  airbrake = airbrake.createClient(process.env['AIRBRAKE_KEY']);
  airbrake.handleExceptions();
}


var Router = require('alice-proxy')
,   Redis  = require('redis')
,   Http   = require('http')
;

var router
,   redis
,   router_id
,   port
,   host
,   alice_host
,   alice_port
;

var _route_domain
,   _detect_maintenance_mode
,   _route_path
,   _select_backend_for_app
,   _select_passer_for_machine
,   _record_stats
;

host = process.env['ROUTER_HOST'] || 'localhost';
port = process.argv[2] || process.env['ROUTER_PORT'] || '5200';
port = parseInt(port, 10);

alice_host = process.env['ALICE_HOST'] || 'localhost';
alice_port = process.env['ALICE_PORT'] || '5000';
alice_port = parseInt(alice_port, 10);

_route_domain = function(env){
  var hostname
  ,   parts
  ,   lookup_hostnames
  ;

  env.router = ''+host+':'+port;
  env.response_headers = {};

  hostname = env.url.hostname;
  parts = hostname.split('.');
  if (parts[parts.length - 1] === '') { parts.pop(); }

  lookup_hostnames = [parts.join('.')+'.'];
  while (parts.length > 0) {
    lookup_hostnames.push('*.' + parts.join('.') + '.');
    parts.shift();
  }

  lookup_hostnames.push('*.');

  redis.hmget('alice.http|domains', lookup_hostnames, function(err, rules){
    var actions
    ,   rule_id
    ,   i
    ;

    if (err) {
      console.error('Redis error: '+err);
      // return 500
      env.respond(500);
      _record_stats(env);
      return;
    }

    for (i in rules) {
      if (rules[i]) {
        actions = JSON.parse(rules[i]);
        rule_id = actions[0];
        actions = actions[1];
        break;
      }
    }

    if (!actions) {
      // return 404
      env.respond(404);
      _record_stats(env);
      return;
    }

    actions.forEach(function(action){
      switch(action[0]){
      case 'cache-control':
        env.response_headers['Cache-Control'] = action[1];
        break;
      case 'forward':
        env.app = action[1];
        env.response_headers['X-Alice-Application'] = action[1];
        break;
      }
    });

    if (!env.app) {
      // return 404
      env.respond(404);
      _record_stats(env);
      return;
    }

    _detect_maintenance_mode(env);
  });
};

_detect_maintenance_mode = function(env){
  var flag_names
  ;

  flag_names = [
    'cache_version',
    'suspended',
    'maintenance'
  ];

  redis.hmget('alice.http|flags:'+env.app, flag_names, function(err, flags){
    if (err) {
      console.error('Redis error: '+err);
      // return 500
      env.respond(500);
      _record_stats(env);
      return;
    }

    // cache_version
    env.response_headers['X-Alice-Cache-Version'] = (flags[0] || '0');
    env.response_headers['etag'] = function(old_value){
      if (old_value) {
        return "" + old_value + "--c" + this.response_headers['X-Alice-Cache-Version'];
      } else {
        return old_value;
      }
    };

    // suspended
    if (flags[1] === '1') {
      env.respond('suspended');
      _record_stats(env);
      return;
    }

    // maintenance
    if (flags[2] === '1') {
      env.respond('maintenance');
      _record_stats(env);
      return;
    }

    _route_path(env);
  });
};

_route_path = function(env){
  var parts
  ,   lookup_paths
  ;

  parts = env.url.path.split('/');
  if (parts[parts.length - 1] === '') { parts.pop(); }
  if (parts.length === 0) { parts.push(''); }

  lookup_paths = [env.url.path];
  while (parts.length > 0) {
    lookup_paths.push(parts.join('/') + '/*');
    parts.pop();
  }

  redis.hmget('alice.http|paths:'+env.app, lookup_paths, function(err, rules){
    var actions
    ,   rule_id
    ,   i
    ;

    if (err) {
      console.error('Redis error: '+err);
      // return 500
      env.respond(500);
      _record_stats(env);
      return;
    }

    for (i in rules) {
      if (rules[i]) {
        actions = JSON.parse(rules[i]);
        rule_id = actions[0];
        actions = actions[1];
        break;
      }
    }

    if (!actions) {
      // return 404
      env.respond(404);
      _record_stats(env);
      return;
    }

    actions.forEach(function(action){
      switch(action[0]){
      case 'cache-control':
        env.response_headers['Cache-Control'] = action[1];
        break;
      case 'forward':
        env.process = action[1];
        env.response_headers['X-Alice-Process'] = action[1];
        break;
      }
    });

    if (!env.process) {
      // return 404
      env.respond(404);
      _record_stats(env);
      return;
    }

    _select_backend_for_app(env);
  });
};

_select_backend_for_app = function(env){
  redis.brpoplpush('alice.http|backends:'+env.app+':'+env.process,
                   'alice.http|backends:'+env.app+':'+env.process,
                   5,
                   function(err, backend){

    if (err) {
      console.error('Redis error: '+err);
      // return 500
      env.respond(500);
      _record_stats(env);
      return;
    }

    if (!backend) {
      // return 503
      env.respond(503);
      _record_stats(env);
      return;
    }

    backend      = JSON.parse(backend);
    rule_id      = backend[0];
    env.machine  = backend[1];
    env.port     = backend[2];
    env.instance = backend[3];

    _select_passer_for_machine(env);
  });
};

_select_passer_for_machine = function(env){
  redis.brpoplpush('alice.http|passers:'+env.machine,
                   'alice.http|passers:'+env.machine,
                   5,
                   function(err, endpoint){
    var rule_id
    ;

    if (err) {
      console.error('Redis error: '+err);
      // return 500
      env.respond(500);
      _record_stats(env);
      return;
    }

    if (!endpoint) {
      env.respond(503);
      _record_stats(env);
      return;
    }

    endpoint   = JSON.parse(endpoint);
    rule_id    = endpoint[0];
    endpoint   = endpoint[1];
    env.passer = env.machine + ':' + endpoint;

    if (env.headers['if-none-match']) {
      env.headers['if-none-match'] = env.headers['if-none-match'].split('--c')[0];
    }

    env.headers['X-Pluto-Backend-Port'] = env.port;
    env.forward(
      env.machine,
      parseInt(endpoint, 10),
      env.response_headers
    );
    _record_stats(env);
  });
};


var next_stat_uuid = 0;
_record_stats = function(env) {
  uuid  = ((next_stat_uuid += 1) * 10000) + port;

  event = JSON.stringify({
    '_type':       "request",
    "machine":     env.machine,
    "router":      env.router,
    "passer":      env.passer,
    "application": env.app,
    "process":     env.process,
    "instance":    env.instance
  });

  redis.multi()
    .lpush("fnordmetric-queue", 'alice:req:'+uuid)
    .set("fnordmetric-event-alice:req:"+uuid, event)
    .expire("fnordmetric-event-alice:req:"+uuid, 60)
    .exec();
};



redis = Redis.createClient();
router = Router.create('router', _route_domain);

router.listen(port);
console.log('listening on port '+port);

var _ping = function(){
  var body
  ,   req
  ;

  body = JSON.stringify([{'type': 'router', 'machine': host, 'port': port}]);

  req = Http.request({
    host: alice_host,
    port: alice_port,
    path: '/api_v1/register.json',
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      'Accepts':        'application/json',
      'Content-Length': body.length
    }
  }, function(res){
    router_id = parseInt(res.headers['x-alice-router-id'], 10);
  });

  req.on('error', function(){
    console.log('Failed to ping!');
  });

  req.write(body);
  req.end();
};

setInterval(_ping, 600000); // every 10 minutes
setTimeout(_ping,   30000);
