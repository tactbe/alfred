var path           = require('path'),
    fs             = require('fs')
    util           = require('util'),
    Step           = require('step'),
    EventEmitter   = require('events').EventEmitter,
    options_merger = require('../util/options_merger'),
    cached_key_map = require('../cached_key_map');

var default_meta_options = {
  meta_compact_interval: 1000 * 60 * 60 // 1 hour, +- 50%
};

var Database = function(db_path, callback) {
  var self = this;
  var options;
  
  if (arguments.length >= 3 && !!arguments[2]) {
    options = arguments[1];
    calback = arguments[2];
  }
  self.options = options_merger.merge(default_meta_options, options);
  
  path.exists(db_path, function(exists) {
    if (!exists) {
      callback(new Error('Path for database ' + path + ' does not exist'));
    } else {
      self.path = path.normalize(db_path);
      self._initialize(callback);
    }
  });
};

util.inherits(Database, EventEmitter);

module.exports.open = function(path, callback) {
  return new Database(path, callback);
};

Database.prototype._path_join = function(subpath) {
  return path.join(this.path, subpath);
};

Database.prototype._initialize = function(callback) {
  var self = this;
  Step(
    function initialize_error() {
      self.on('error', function(error) {
        if (self.listeners('error').length <= 1) {
          // if no one else is listening to error events, just throw the error into the event loop
          throw error;
        }
      });
      this();
    },
    function initialize_metadata(err) {
      if (err) {
        callback(err);
        return;
      }
      var metadata_path = self._path_join('metadata.alf');
      cached_key_map.open(metadata_path, this);
    },
    function initialize_metadata_compact(err, meta) {
      if (err) {
        callback(err);
        return;
      }
      if (self.options.meta_compact_interval > 0) {
        var compact_interval = self.options.meta_compact_interval;
        var schedule_meta_compact = function() {
          // To avoid a compact storm, we schedule it randomly by compact_interval +- 50%
          var timeout = compact_interval + Math.floor(Math.random() * compact_interval) - Math.floor(compact_interval / 2);
          self._compact_timeout = setTimeout(function() {
            if (!self._stop_compact_timeout) {
              key_map.compact(function(err) {
                if (err) { self.emit('error', err); }
                schedule_meta_compact();
              });
            }
          }, timeout);
        };
        schedule_meta_compact();
        delete self._stop_compact_timeout;

        // call compact on key_map.end
        var old_end = meta.end;
        meta.end = function(callback) {
          if (meta._compact_timeout) {
            clearTimeout(meta._compact_timeout);
            delete meta._compact_timeout;
          }
          meta._stop_compact_timeout = true;
          old_end.call(meta, callback);
        };
      }
      
      this(null, meta);
    },
    function initialize_key_maps(err, meta) {
      if (err) {
        callback(err);
      } else {
        self.meta = meta;
        self.key_maps = {};
        self.indexes = {};
        self.state = 'initializing';
        this();
      }
    },
    function read_commands_dir(err) {
      if (err) {
        callback(err);
        return;
      }
      fs.readdir(__dirname + '/commands', this);
    },
    function initialize_commands(err, command_files) {
      if (err) {
        callback(err);
        return;
      }
      command_files.forEach(function(command_file) {
        var command = require('./commands/' + command_file);
        command.register(self);
      });
      self.load(this);
    },
    function handleShutdowns(err) {
      if (err) {
        callback(err);
        return;
      }
      self.shutdown_handler = function() {
        if (self.state != 'closing' && self.state != 'closed') {
          self.closeSync();
        }
      };
      process.on('exit', self.shutdown_handler);
      this();
    },
    function finalize(err) {
      if (err) {
        callback(err);
        return;
      }
      self.state = 'open';
      callback(null, self);
    }
  );
};

Database.prototype.load = function(callback) {
  var self = this;
  self._load_key_maps(function(err) {
    if (err) { callback(err); return; }
    self._load_indexes(callback);
  })
}

Database.prototype._load_key_maps = function(callback) {
  var self = this;
  this.meta.get('key_maps', function(err, value) {
    if (err) { callback(err); return; }
    if (value) {
      var key_maps = value;
      var _key_maps = [];
      for (key_map_name in key_maps) {
        if (key_maps.hasOwnProperty(key_map_name)) {
          _key_maps.push(key_maps[key_map_name]);
        }
      }
      
      if (_key_maps.length == 0) {
        callback(null);
        return;
      }
      
      var executed = 0;
      _key_maps.forEach(function(key_map) {
        (function(key_map) {
          self.executeCommand(key_map.command, key_map['arguments'], function(err) {
            if (err) {
              callback(err);
            } else {
              executed ++
              if (executed == _key_maps.length) {
                callback(null);
              }
            }
          });
        })(key_map);
        
      });
    } else {
      callback(null);
    }
  });
}

Database.prototype._load_indexes = function(callback) {
  var self = this;
  this.meta.get('indexes', function(err, indexes) {
    if (err) {
      callback(err);
      return;
    }
    if (indexes) {
      var run_indexes = [];
      for (var key_map_name in indexes) {
        if (indexes.hasOwnProperty(key_map_name)) {
          var key_map_indexes = indexes[key_map_name];
          for (var index_name in key_map_indexes) {
            if (key_map_indexes.hasOwnProperty(index_name)) {
              run_indexes.push(key_map_indexes[index_name]);
            }
          }
        }
      }
      
      if (run_indexes.length == 0) {
        callback(null);
        return;
      }
      
      run_indexes.forEach(function(run_index) {
        var key_map_indexes = indexes[key_map_name];
        var index_commands = [];
        for (var index_name in key_map_indexes) {
          if (key_map_indexes.hasOwnProperty(index_name)) {
            index_commands.push(key_map_indexes[index_name]);
          }
        }
        if (index_commands.length == 0) {
          callback(null);
        } else {
          var ran_commands = 0;
          index_commands.forEach(function(index_command) {
            self.executeCommand(index_command.command, index_command.arguments, function(err) {
              if (err) {
                callback(err);
                return;
              }
              ran_commands ++;
              if (ran_commands == index_commands.length) {
                callback(null);
              }
            });
          });
        }
      });
    } else {
      callback(null);
    }
  });
}

Database.prototype.save_key_maps = function(callback) {
  this.meta.put('key_maps', this.key_maps, callback);
};

Database.prototype.save_indexes = function(callback) {
  this.meta.put('indexes', this.indexes, callback);
};

Database.prototype.close = function(callback) {
  var self = this;
  var key_map_names = []
  
  if (self.state == 'closing') {
    callback('Database is already closing');
    return;
  }
  if (self.state == 'closed') {
    callback('Database is already closed');
    return;
  }
  self.state = 'closing';
  
  if (self.shutdown_handler) {
    process.removeListener('exit', self.shutdown_handler);
    delete self.shutdown_handler;
  }
  
  for (key_map_name in this.key_maps) {
    if (this.key_maps.hasOwnProperty(key_map_name)) {
      key_map_names.push(key_map_name);
    }
  }
  
  if (key_map_names.length == 0) {
    self.meta.end(callback);
    return;
  }
  
  var done = 0;
  key_map_names.forEach(function(key_map_name) {
    var key_map = self[key_map_name];
    key_map.end(function(err) {
      if (err) {
        callback(err);
      } else {
        delete self[key_map_name];
        done ++;
        if (done == key_map_names.length) {
          self.meta.end(function(err) {
            self.state = 'closed';
            callback(err);
          });
        }
      }
    });
  });
};

Database.prototype.closeSync = function() {

  for (key_map_name in this.key_maps) {
    if (this.key_maps.hasOwnProperty(key_map_name)) {
      this[key_map_name].endSync();
    }
  }

  if (this.shutdown_handler) {
    process.removeListener('exit', this.shutdown_handler);
    delete this.shutdown_handler;
  }
  this.state = 'closed';
};

/* Commands */

Database.prototype.registerCommand = function(command_name, command_constructor) {
  var self = this;
  this[command_name] = function() {
    // last argument is a callback
    var command_args = [];
    for (argument_index in arguments) {
      if (argument_index < (arguments.length - 1)) {
        command_args.push(arguments[argument_index])
      }
    }
    var command = command_constructor.apply(null, command_args);
    command.do(self, arguments[arguments.length - 1]);
  };
};

Database.prototype.executeCommand = function(command_name, arguments, callback) {
  var command = this[command_name];
  if (!command) {
    callback(new Error('Command ' + command_name + ' not found'));
    return;
  }
  arguments.push(callback);
  command.apply(this, arguments);
};